/**
 * 顶层编排：组装场景 / 物理 / 后处理 / UI / 音效，驱动固定步长模拟与渲染循环。
 * 玩法流程：MENU → COUNTDOWN → ACCEL（油门滑条）→ BRAKE（刹车滑条）→ STOPPED / CRASHED。
 */
import * as THREE from 'three';
import { Sfx, vibrate } from '../audio/Sfx';
import { BRAKE, CRASH, MS_TO_KMH, REDUNDANCY, VEHICLE } from '../config/physics';
import { AdaptiveQuality, type QualitySettings } from '../config/quality';
import { World } from '../physics/World';
import { FxSystems } from '../fx';
import { CYCLE_VIEWS, CameraRig } from '../render/CameraRig';
import type { CameraMode } from '../render/CameraRig';
import { Postfx } from '../render/Postfx';
import { createRenderer } from '../render/Renderer';
import { createV800CarAdapter, type CarLike } from '../model/V800Adapter';
import { Environment } from '../render/scene/Environment';
import { ContactShadow } from '../render/scene/ContactShadow';

import { Lighting } from '../render/scene/Lighting';
import { Road } from '../render/scene/Road';
import { Terrain } from '../render/scene/Terrain';
import { Waterway } from '../render/scene/Waterway';
import { clamp, damp, lerp } from '../util/math';
import { Hud } from '../ui/Hud';
import type { HudInput } from '../ui/Hud';
import { Menu } from '../ui/Menu';
import { Result } from '../ui/Result';
import { Sliders } from '../ui/Sliders';
import { Loop } from './Loop';
import type { GameEvent, RunResult } from './StateMachine';
import { StateMachine } from './StateMachine';

const PHYSICS_HZ = 120;
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
  private readonly road: Road;
  private readonly waterway: Waterway;
  private readonly car: CarLike;
  private readonly fx: FxSystems;
  private readonly crashWorld: World;
  private readonly sfx = new Sfx();
  private readonly sm = new StateMachine();
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly result: Result;
  private readonly sliders: Sliders;
  private readonly loop: Loop;
  private readonly qualityGovernor: AdaptiveQuality;

  private time = 0;
  /** 窗口事件句柄（dispose 时统一解绑，避免 HMR 泄漏） */
  private readonly onResize = (): void => this.resize();
  private readonly onOrientation = (): void => {
    window.setTimeout(() => this.resize(), 250);
  };
  private prevDistance = 0;
  private brakeFlash = 0;
  private pendingResult: { result: RunResult; delay: number } | null = null;
  private crashElapsed = 0;
  private forceBrakeTick = false;
  /** V 键循环游标（ACCEL/BRAKE 段可用视角） */
  private cycleIndex = 0;
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
  /** cabin 机位专用遮挡件（前挡玻璃），进入/离开车内视角时切换可见性 */
  private readonly windshieldMeshes: THREE.Mesh[] = [];
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
    this.qualityGovernor = new AdaptiveQuality(quality);

    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.env = new Environment(this.scene, this.renderer, quality.envMapSize);
    this.lighting = new Lighting(this.scene, quality, this.env.sunDirection);
    this.contactShadow = new ContactShadow(this.scene);
    this.road = new Road(this.scene, this.renderer.capabilities.getMaxAnisotropy());
    new Terrain(this.scene);
    this.waterway = new Waterway(this.scene);
    this.car = createV800CarAdapter(quality.tier);
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

    this.postfx = new Postfx(this.renderer, this.scene, this.rig.camera, quality);
    this.crashWorld = new World(this.scene, (impact) => {
      this.lastImpactStrength = impact.strength;
      this.sfx.impact(impact.strength);
      this.rig.addShake(0.25 * impact.strength);
    });

    // ---- UI ----
    this.hud = new Hud({
      onSelectView: (mode) => this.selectView(mode)
    });
    this.menu = new Menu(
      () => this.startRun(),
      () => this.sfx.setMuted(!this.sfx.isMuted)
    );
    this.result = new Result(
      () => this.startRun(),
      () => {
        this.sfx.unlock();
        this.sfx.uiClick();
      }
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
    // 首帧后回调（隐藏加载屏）
    requestAnimationFrame(() => onFirstFrame());

    this.menu.show(true);
    this.rig.setMode('orbit');
    this.car.setBrakeLights(1.6);
  }

  /** renderer 初始化见 render/Renderer.ts（结构要素 1：WebGLRenderer） */

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

  /** V 键：ACCEL/BRAKE 段循环 chase→hood→cabin→side */
  private cycleCamera(): void {
    if (this.sm.phase !== 'accel' && this.sm.phase !== 'brake') return;
    this.cycleIndex = (this.cycleIndex + 1) % CYCLE_VIEWS.length;
    this.rig.setMode(CYCLE_VIEWS[this.cycleIndex]);
    this.hud.setActiveView(CYCLE_VIEWS[this.cycleIndex]);
    this.sfx.uiClick();
  }

  /** HUD 视角按钮：直接切到指定视角 */
  private selectView(mode: CameraMode): void {
    if (this.sm.phase !== 'accel' && this.sm.phase !== 'brake') return;
    const idx = CYCLE_VIEWS.indexOf(mode);
    if (idx >= 0) this.cycleIndex = idx;
    this.rig.setMode(mode);
    this.hud.setActiveView(mode);
    this.sfx.uiClick();
  }

  /** 固定步长物理推进（1/120s） */  private tick(step: number): void {
    if (this.probeFrames !== null) this.probeTicks++;
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
        // 车内视角停留看踏板脱落，之后交还常规机位（玩家仍可自由拖拽环视）
        this.snapCamReturn = this.rig.mode === 'cabin' ? null : this.rig.mode;
        this.rig.setMode('cabin');
        this.hud.setActiveView('cabin');
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
        // 翻滚演出只留给撞路障（断裂已改为冗余接管，不再有凭空的翻滚能量来源）
        const speedMs = this.sm.vehicle.speed;
        this.rig.setMode('crash');
        this.hud.setActiveView('crash');
        this.settleTimer = 0;
        this.hud.setRedundancyActive(false);
        this.car.body.rotation.set(0, MODEL_BASE_YAW, 0); // 保留基准偏航 π，只清俯仰/横滚
        this.crashWorld.begin(this.car.root, speedMs, this.road.barrierBlocks);
        this.crashElapsed = 0;
        this.sfx.impact(1);
        this.fx.burstSparks(this.car.root.localToWorld(new THREE.Vector3(0, 0.6, -2.7)));
        this.brakeFlash = 0.5;
        this.rig.addShake(0.8);
        this.hud.showToast('撞上路障！', true, 2200);
        vibrate([90, 40, 200]);
        this.pendingResult = { result: event.result, delay: CRASH.resultDelaySeconds };
        break;
      }
    }
  }

  /** 渲染帧：视觉更新 + 后处理 + HUD（结构要素 4：渲染循环内部） */
  private frame(dt: number, alpha: number): void {
    this.time += dt;
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
    this.road.update(this.time);
    this.waterway.update(this.time);

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
      if (this.snapCamTimer <= 0 && this.rig.mode === 'cabin' && this.snapCamReturn) {
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
    const wantHide = this.rig.mode === 'cabin';
    if (wantHide !== this.windshieldHidden) {
      this.windshieldHidden = wantHide;
      for (const m of this.windshieldMeshes) m.visible = !wantHide;
    }
    const speedBlur =
      pedaling && this.sm.phase !== 'countdown' ? Math.min(1, vehicle.speed / 72) ** 1.6 * 0.07 : 0;
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

    // ---- 渲染（结构要素 1 的最终呈现）----
    this.postfx.render();

    // ---- 自适应画质 ----
    const dr = this.qualityGovernor.update(dt);
    if (dr !== 0) {
      this.renderer.setPixelRatio(this.qualityGovernor.pixelRatio);
      this.postfx.setPixelRatio(this.qualityGovernor.pixelRatio);
    }
    void this.lastImpactStrength;

    // ---- perf-r14 帧探针（DEV only；读后清零 info 保证读数是整帧累计）----
    if (this.probeFrames !== null) {
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
    this.loop.dispose();
    this.sfx.dispose();
    this.fx.dispose();
    this.sliders.dispose();
    this.postfx.dispose();
    this.contactShadow.dispose();
    this.waterway.dispose();
    this.crashWorld.dispose();
    this.car.dispose();
    this.result.destroy();
    this.renderer.dispose();
  }
}
