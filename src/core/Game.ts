/**
 * 顶层编排：组装场景 / 物理 / 后处理 / UI / 音效，驱动固定步长模拟与渲染循环。
 * 玩法流程：MENU → COUNTDOWN → ACCEL（油门滑条）→ BRAKE（刹车滑条）→ STOPPED / CRASHED。
 */
import * as THREE from 'three';
import { Sfx, vibrate } from '../audio/Sfx';
import { BRAKE, CRASH, MS_TO_KMH, VEHICLE } from '../config/physics';
import { AdaptiveQuality, type QualitySettings } from '../config/quality';
import { World } from '../physics/World';
import { FxSystems } from '../fx';
import { CYCLE_VIEWS, CameraRig } from '../render/CameraRig';
import type { CameraMode } from '../render/CameraRig';
import { Postfx } from '../render/Postfx';
import { createRenderer } from '../render/Renderer';
import { createV800CarAdapter, type CarLike } from '../model/V800Adapter';
import { Environment } from '../render/scene/Environment';

import { Lighting } from '../render/scene/Lighting';
import { Road } from '../render/scene/Road';
import { Terrain } from '../render/scene/Terrain';
import { clamp, damp, lerp } from '../util/math';
import { Hud } from '../ui/Hud';
import { Menu } from '../ui/Menu';
import { Result } from '../ui/Result';
import { Sliders } from '../ui/Sliders';
import { Loop } from './Loop';
import type { GameEvent, RunResult } from './StateMachine';
import { StateMachine } from './StateMachine';

const PHYSICS_HZ = 120;

export class Game {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly rig: CameraRig;
  private readonly postfx: Postfx;
  private readonly env: Environment;
  private readonly lighting: Lighting;
  private readonly road: Road;
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
  /** 自动测试钩子：URL hash 含 autodrive 时，油门全开→限速自动切入→满刹车（QA 用） */
  private readonly autoDrive = window.location.hash.includes('autodrive');

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
    this.road = new Road(this.scene, this.renderer.capabilities.getMaxAnisotropy());
    new Terrain(this.scene);
    this.car = createV800CarAdapter();
    this.scene.add(this.car.root);
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
    this.car.body.rotation.set(0, 0, 0);
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
    this.prevDistance = this.sm.vehicle.distance;
    // 自动切入：加速段达到电子限速稳态
    if (this.sm.phase === 'accel' && this.sm.atLimiter) this.forceBrakeTick = true;
    const phase = this.sm.phase;
    const autoThrottle = this.autoDrive && phase === 'accel' ? 1 : 0;
    const autoBrake = this.autoDrive && phase === 'brake' ? 0.9 : 0; // 0.9：低于断裂阈值，验证成功刹停路径；改 1 可验证断裂路径
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
      case 'stopped':
        // 结算段：电影侧机位 2s → orbit（frame 内按 settleTimer 推进）
        this.settleTimer = 0;
        this.rig.setMode('side');
        this.hud.setActiveView('side');
        this.sfx.success();
        vibrate([30, 50, 30]);
        this.hud.showToast('完美刹停！', false, 1600);
        this.pendingResult = { result: event.result, delay: 1.8 };
        break;
      case 'crash': {
        const speedMs = this.sm.vehicle.speed;
        this.rig.setMode('crash');
        this.hud.setActiveView('crash');
        this.settleTimer = 0;
        this.car.body.rotation.set(0, 0, 0);
        this.crashWorld.begin(this.car.root, event.reason, speedMs, this.road.barrierBlocks);
        this.crashElapsed = 0;
        if (event.reason === 'brake_snap') {
          this.sfx.snap();
          this.car.flashBrakeSnap();
          this.fx.burstSparks(this.car.root.localToWorld(new THREE.Vector3(0, 0.55, -2.2)));
          this.brakeFlash = 0.85;
          this.rig.addShake(0.6);
          this.hud.showToast('刹车踏板断裂！', true, 2200);
        } else {
          this.sfx.impact(1);
          this.fx.burstSparks(this.car.root.localToWorld(new THREE.Vector3(0, 0.6, -2.7)));
          this.brakeFlash = 0.5;
          this.rig.addShake(0.8);
          this.hud.showToast('撞上路障！', true, 2200);
        }
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
    this.car.setBrakeLights(braking && this.sm.pedal.pedalForce > 1 ? 8 : 1.6);
    this.car.setHeadlights(this.sm.phase !== 'menu');
    this.car.update(this.rig.camera);

    // ---- 灯光 / 环境 / 路侧 ----
    const focus = this.sm.phase === 'crashed' ? this.crashWorld.focus : this.car.root.position;
    this.lighting.update(focus);
    this.env.update(this.rig.camera.position);
    this.road.update(this.time);

    // ---- 内饰仪表 ----
    this.car.updateCluster(
      this.sm.phase === 'crashed' ? this.crashWorld.carSpeed * MS_TO_KMH : this.sm.speedKmh,
      this.sm.pedal.pedalForce,
      Math.abs(vehicle.accel) / 9.81,
      braking ? 'B' : 'D'
    );

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
    const speedBlur =
      pedaling && this.sm.phase !== 'countdown' ? Math.min(1, vehicle.speed / 72) ** 1.6 * 0.07 : 0;
    this.postfx.setSpeedBlur(speedBlur);
    this.brakeFlash = Math.max(0, this.brakeFlash - dt * 2.2);
    this.postfx.setFlash(this.brakeFlash);

    // ---- 音效（电机 / 风噪 / 胎啸 / 回收提示）----
    this.sfx.updateEngine(this.sm.speedKmh, pedaling && !braking);
    this.sfx.updateWind(vehicle.speed / (VEHICLE.maxSpeedKmh / MS_TO_KMH));
    this.sfx.updateSqueal(braking ? Math.min(1, this.sm.pedal.pedalForce / BRAKE.breakForceN) : 0, vehicle.speed);
    this.sfx.updateRegen(vehicle.regenPowerKw > 1);

    // ---- 特效（轮胎烟 / 刹车痕 / 火花；low 档内部自动关闭）----
    this.fx.update(dt, {
      carRoot: this.car.root,
      brakeIntensity: braking ? Math.min(1, this.sm.pedal.pedalForce / BRAKE.breakForceN) : 0,
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

    // ---- HUD ----
    this.hud.update({
      speedKmh: this.sm.phase === 'crashed' ? this.crashWorld.carSpeed * MS_TO_KMH : this.sm.speedKmh,
      brakeSeconds: this.sm.brakeElapsed,
      distanceToBarrier: this.sm.distanceToBarrier,
      pedalForce: this.sm.pedal.pedalForce,
      regenPowerKw: vehicle.regenPowerKw,
      brakeTemp: vehicle.brakeTemp,
      overheat: vehicle.overheat,
      scorePreview: this.sm.scorePreview,
      canBrake: this.sm.canBrake,
      braking,
      atLimiter: this.sm.atLimiter
    });
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
    this.loop.dispose();
    this.sfx.dispose();
    this.fx.dispose();
    this.sliders.dispose();
    this.postfx.dispose();
    this.crashWorld.dispose();
    this.renderer.dispose();
  }
}
