/**
 * 多视角相机 rig（P3 扩展为六模式，注册表驱动）：
 * - chase  追随（动态 FOV 55→68 随速度 + 震屏）
 * - hood   机盖前视（前挡下沿上方，向前看）
 * - cabin  车内驾驶员视角（左舵目高 ~1.15m，near 降到 0.05 防内饰裁剪）
 * - orbit  环绕（菜单/结算）
 * - side   电影侧机位（车侧平行跟拍；STOPPED/CRASHED 结算段由 Game 自动切入）
 * - crash  翻滚远景（撞车慢动作段）
 * hood/cabin/side 使用车体局部偏移（local=true，随车体朝向旋转）；
 * 切换通过指数阻尼做 0.4~0.6s 的位置/朝向插值，不瞬跳。
 */
import * as THREE from 'three';
import type { InteriorViews } from '../config/vehicles';
import { clamp } from '../util/math';

export type CameraMode =
  | 'orbit'
  | 'chase'
  | 'hood'
  | 'cabin'
  | 'cabinDriver'
  | 'cabinPassenger'
  | 'cabinRear'
  | 'side'
  | 'crash';

/** V 键在 ACCEL/BRAKE 段可循环的视角（orbit 仅供菜单/结算） */
export const CYCLE_VIEWS: readonly CameraMode[] = ['chase', 'hood', 'cabin', 'side'];

/** 车内机位集合（前挡遮挡件要在这些模式下隐藏；自由视角走「转头」而非「环绕」） */
const INTERIOR_MODES: ReadonlySet<CameraMode> = new Set<CameraMode>([
  'cabin',
  'cabinDriver',
  'cabinPassenger',
  'cabinRear'
]);

/** 是否车内机位（前挡从内部看是一块灰板，需隐藏；拖拽=转头而非环绕） */
export function isInteriorMode(mode: CameraMode): boolean {
  return INTERIOR_MODES.has(mode);
}

/** 按车型生成 V 键循环表：V800 5 档（含 orbit）；R7 7 档（三内饰机位） */
export function cycleViewsFor(hasInteriorViews: boolean): readonly CameraMode[] {
  return hasInteriorViews
    ? ['chase', 'hood', 'cabinDriver', 'cabinPassenger', 'cabinRear', 'orbit', 'side']
    : ['chase', 'hood', 'cabin', 'orbit', 'side'];
}

interface ModePose {
  offset: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
  /** 偏移追踪刚度（仅用于机位切换的位姿过渡） */
  k: number;
  near: number;
  /** true = 偏移在车体局部坐标系（随车头朝向旋转） */
  local: boolean;
}

/**
 * 机位姿态表。P4 性能：写入共享 POSE 对象而非每帧 new（每帧省 2 个 Vector3 + 1 个对象字面量）。
 * 同一时刻只有一种机位生效，共享写入安全。
 */
const POSE: ModePose = {
  offset: new THREE.Vector3(),
  look: new THREE.Vector3(),
  fov: 55,
  k: 2,
  near: 0.1,
  local: false
};

/**
 * 内置车内机位（未注入 interiorViews 时的统一回退 = 原 cabin 偏移）
 *
 * R15 实证：原眼点 (−0.55, 1.33, −0.58) 落在**第一排靠背前方 12cm**——
 * leather-warm 合批（含菱格座椅）世界 z 从 −0.456 起，眼点 −0.58 正好贴着靠背，
 * 车里看到的那块「中央隔板实体模块」就是它（挂上参考图后被读成一面绗缝大墙）。
 * 眼点前移 27cm 到 −0.85 越过靠背，并略降 5cm，正前方视野才落到仪表台+路面上。
 */
const CABIN_EYE: readonly [number, number, number] = [-0.55, 1.28, -0.85];
const CABIN_TARGET: readonly [number, number, number] = [-0.42, 1.02, -9];

/**
 * QA 机位标定钩子：`#eye=x,y,z,tx,ty,tz` 覆盖内建 cabin 机位（世界坐标）。
 * 用途：车内视角「被某块面挡住」时，沿纵深逐点扫描找可行的眼点，
 * 比反复改源码再重启快一个数量级。仅在 hash 显式给出时生效。
 */
const CABIN_EYE_OVERRIDE: readonly [number, number, number] | null = (() => {
  if (typeof window === 'undefined') return null;
  const m = /[#&]eye=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)(?:,(-?[\d.]+),(-?[\d.]+),(-?[\d.]+))?/.exec(
    window.location.hash
  );
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
})();
const CABIN_TARGET_OVERRIDE: readonly [number, number, number] | null = (() => {
  if (typeof window === 'undefined') return null;
  const m = /[#&]eye=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)(?:,(-?[\d.]+),(-?[\d.]+),(-?[\d.]+))?/.exec(
    window.location.hash
  );
  if (!m || m[4] === undefined) return null;
  return [Number(m[4]), Number(m[5]), Number(m[6])];
})();

const MODES: Record<CameraMode, (speed: number, portrait: boolean, time: number) => void> = {
  orbit: (_speed, portrait, time) => {
    // 相位 3π/4：t=0 机位落在右前 45°（游戏里车头朝 -Z，无相位时 t=0 正对车尾，
    // 菜单首印象是屁股——2026-10-17 第四轮审查 S5④）
    const phase = Math.PI * 0.75;
    const radius = portrait ? 9.5 : 7.8;
    POSE.offset.set(Math.sin(time * 0.16 + phase) * radius, portrait ? 2.4 : 1.5, Math.cos(time * 0.16 + phase) * radius);
    POSE.look.set(0, portrait ? -1.6 : 0.85, 0);
    POSE.fov = portrait ? 58 : 42;
    POSE.k = 2;
    POSE.near = 0.1;
    POSE.local = false;
  },
  chase: (speed) => {
    // 动态 FOV：55 → 68 随速度
    const e = Math.min(speed / 72, 1);
    // 车距 = 基准 8.2 − 1.4e + 显式速度回拉 speed/5。
    // 最后这项是把旧 anchor 阻尼（anchorK=5）的**稳态**滞后 v/5 显式搬到姿态里：
    // 构图与 R13 完全一致（55 m/s 时相机在车后 17.9 m），但它现在是确定性的
    // 速度函数，不再由 dt 逐帧积分 —— 既不抖，也不会把 dt 尖刺写进相对位移。
    POSE.offset.set(1.6 - e * 1.2, 2.2 - e * 0.5, 8.2 - e * 1.4 + speed / 5);
    POSE.look.set(0, 1, -6);
    POSE.fov = 55 + e * 13;
    POSE.k = 2.5;
    POSE.near = 0.1;
    POSE.local = false;
  },
  hood: () => {
    // 引擎盖正上方（风挡玻璃之外），向前略俯视路面
    POSE.offset.set(0, 1.45, -1.45);
    POSE.look.set(0, 0.95, -16);
    POSE.fov = 66;
    POSE.k = 4;
    POSE.near = 0.1;
    POSE.local = true;
  },
  cabin: () => {
    // 驾驶位头枕前方，目高 1.27m（R14：原 1.16 只比仪表台顶 1.012 高 15cm，
    // 且眼点 z=-0.45 落在驾驶座靠背实体内部 → 半屏被一块皮革/台面大板占满）。
    // 现眼点前移到座椅壳外（射线扫描 minDist 0.15m 只碰到透明的侧窗玻璃），
    // 抬高到 1.27 使台面只压住画面底部约 1/4，注视点略下压看前方路面。
    POSE.offset.set(...(CABIN_EYE_OVERRIDE ?? CABIN_EYE));
    POSE.look.set(...(CABIN_TARGET_OVERRIDE ?? CABIN_TARGET));
    POSE.fov = 68;
    POSE.k = 4;
    POSE.near = 0.05;
    POSE.local = true;
  },
  cabinDriver: () => setInteriorPose('driver'),
  cabinPassenger: () => setInteriorPose('passenger'),
  cabinRear: () => setInteriorPose('rear'),
  side: () => {
    // 车侧平行跟拍机位
    POSE.offset.set(4.6, 1.5, 0.6);
    POSE.look.set(0, 0.85, -0.6);
    POSE.fov = 45;
    POSE.k = 3;
    POSE.near = 0.1;
    POSE.local = true;
  },
  crash: () => {
    POSE.offset.set(9, 4.5, 13);
    POSE.look.set(0, 0, 0);
    POSE.fov = 55;
    POSE.k = 2.2;
    POSE.near = 0.1;
    POSE.local = false;
  }
};

const IDENT = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * 装配注入的内饰三机位（模块级单例：进程内只有一个 rig，见 Game）。
 * 未注入时各槽位回退到内置 cabin 偏移（CABIN_EYE/CABIN_TARGET）。
 */
let INTERIOR_VIEWS: InteriorViews | null = null;

function setInteriorPose(slot: keyof InteriorViews): void {
  const v = INTERIOR_VIEWS?.[slot];
  if (!v) {
    POSE.offset.set(...CABIN_EYE);
    POSE.look.set(...CABIN_TARGET);
  } else {
    // 装配层给的是**装配局部坐标**（spec 口径：+Z 车头）。运行时 POSE 是**世界偏移**
    // （Game 传入的 carQuat 取 root.quaternion = 恒等，车身 π 偏航在 body 内部），
    // 两者差一个绕 Y 的 180°：x、z 全部取反。内置 CABIN_EYE 已是反好的世界值。
    POSE.offset.set(-v.eye[0], v.eye[1], -v.eye[2]);
    POSE.look.set(-v.target[0], v.target[1], -v.target[2]);
  }
  POSE.fov = 68;
  POSE.k = 4;
  POSE.near = 0.05;
  POSE.local = true;
}
/** 自由视角限位：偏航 ±225°（可绕到车后再多半圈）、俯仰 ±63°（防过顶翻转/钻地） */
const YAW_LIMIT = Math.PI * 1.25;
const PITCH_LIMIT = 1.1;

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'orbit';
  private shake = 0;
  private time = 0;
  private offset = new THREE.Vector3(6, 1.6, 6);
  private lookOffset = new THREE.Vector3(0, 0.85, 0);
  private anchor = new THREE.Vector3();
  private tmpOffset = new THREE.Vector3();
  private tmpLook = new THREE.Vector3();
  /** 自由视角：用户拖拽产生的偏航/俯仰偏移与缩放（双击或切机位复位） */
  private userYaw = 0;
  private userPitch = 0;
  private userZoom = 1;
  private dragging = false;
  private tmpSph = new THREE.Spherical();
  private tmpRight = new THREE.Vector3();
  /** 车型视距微调（profile.cameraScale ?? 1），只作用于外部机位 */
  private viewScale = 1;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 12000);
    this.camera.position.copy(this.offset);
  }

  /**
   * 注入装配局部坐标的三个内饰机位（CarLike.interiorViews?）。
   * 传 null / 未调用 → cabinDriver/Passenger/Rear 退回内置 cabin 偏移（不会白屏）。
   */
  setInteriorViews(views: InteriorViews | null): void {
    INTERIOR_VIEWS = views;
  }

  /** 车型视距微调（profile.cameraScale；默认 1 = 原机位距离） */
  setViewScale(scale: number): void {
    this.viewScale = scale > 0 ? scale : 1;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    // 切机位（V 键 / HUD 按钮 / 结算自动机位）时自由视角归零
    this.resetLook();
  }

  addShake(amount: number): void {
    this.shake = Math.max(this.shake, amount);
  }

  /** 拖拽增量：dx→偏航，dy→俯仰（外部机位为环绕惯例：上拖 = 相机升高俯视） */
  addLook(dx: number, dy: number): void {
    this.dragging = true;
    this.userYaw = clamp(this.userYaw - dx * 0.005, -YAW_LIMIT, YAW_LIMIT);
    this.userPitch = clamp(this.userPitch + dy * 0.004, -PITCH_LIMIT, PITCH_LIMIT);
  }

  endLook(): void {
    this.dragging = false;
  }

  /** 滚轮 / 捏合缩放（仅外部机位生效） */
  addZoom(deltaY: number): void {
    this.userZoom = clamp(this.userZoom * (deltaY > 0 ? 1.1 : 0.9), 0.55, 2.2);
  }

  resetLook(): void {
    this.userYaw = 0;
    this.userPitch = 0;
    this.userZoom = 1;
    this.dragging = false;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** 只读锚点（perf-r14 帧探针判定相机-车相对位移用；外部勿写） */
  get anchorView(): THREE.Vector3 {
    return this.anchor;
  }

  update(dt: number, target: THREE.Vector3, speed: number, carQuat: THREE.Quaternion = IDENT): void {
    const cam = this.camera;
    const portrait = cam.aspect < 1;
    this.time += dt;
    MODES[this.mode](speed, portrait, this.time);
    const pose = POSE;

    // 局部视角（hood/cabin*/side）偏移随车体朝向旋转
    const q = pose.local ? carQuat : IDENT;
    const off = this.tmpOffset.copy(pose.offset).applyQuaternion(q);
    const look = this.tmpLook.copy(pose.look).applyQuaternion(q);
    // 车型视距微调（profile.cameraScale，默认 1）：只作用于**外部**机位的机位距离，
    // 车内机位不动 —— 眼点是装配给的实测坐标，缩放会把相机塞进座椅/台面里。
    if (this.viewScale !== 1 && !isInteriorMode(this.mode)) off.multiplyScalar(this.viewScale);

    // 自由视角覆盖层：第一人称（hood/cabin*）偏转视线方向；外部机位绕锚点环绕 + 缩放。
    // 叠加在既有阻尼机位系统之上，不改动任何原插值逻辑（每帧零分配）。
    if (this.userYaw !== 0 || this.userPitch !== 0 || this.userZoom !== 1) {
      if (isInteriorMode(this.mode) || this.mode === 'hood') {
        if (this.userYaw !== 0) look.applyAxisAngle(UP, this.userYaw);
        if (this.userPitch !== 0) {
          const right = this.tmpRight.copy(look).cross(UP).normalize();
          look.applyAxisAngle(right, -this.userPitch); // 上拖 = 抬视线
        }
      } else {
        const sph = this.tmpSph.setFromVector3(off);
        sph.theta += this.userYaw;
        sph.phi = clamp(sph.phi + this.userPitch, 0.2, Math.PI - 0.2); // 防过顶/穿地
        off.setFromSpherical(sph).multiplyScalar(this.userZoom);
      }
    }

    // 锚点**直接跟随**（perf-r14）：原实现 anchor.lerp(target, 1-exp(-dt*anchorK))
    // 在 anchorK=5 下形成 v/5 的稳态滞后（30 m/s → 6 m、55 m/s → 11 m），
    // 且滞后量随加速持续漂移 = 相机-车相对位移单向拉长（仿真实测 3s 内 3.0 m /
    // 满载 11 m）。这层二次阻尼没有任何构图收益（构图由 pose.offset 决定），
    // 却让「车距」变成速度的函数、并把任何 dt 抖动直接写进相对位移。
    // 改为刚性跟随：机位切换的平滑仍由下面的 offset/lookOffset 指数阻尼负责。
    this.anchor.copy(target);
    // 指数阻尼 → 模式切换约 0.4~0.6s 内收敛，不瞬跳
    const s = 1 - Math.exp(-dt * pose.k);
    this.offset.lerp(off, s);
    this.lookOffset.lerp(look, Math.min(1, s * 1.5));
    cam.position.copy(this.anchor).add(this.offset);
    this.shake = Math.max(0, this.shake - dt * 1.4);
    if (this.shake > 0) {
      const t = this.time;
      const sh = this.shake;
      cam.position.x += sh * (Math.sin(t * 23.3) * 0.6 + Math.sin(t * 41.7 + 1.3) * 0.4) * 0.5;
      cam.position.y += sh * (Math.sin(t * 29.1 + 0.7) * 0.6 + Math.sin(t * 47.9 + 2.1) * 0.4) * 0.5;
    }
    cam.lookAt(
      this.anchor.x + this.lookOffset.x,
      this.anchor.y + this.lookOffset.y,
      this.anchor.z + this.lookOffset.z
    );
    // cabin 需要 near≈0.05 防内饰裁剪；其余模式维持 0.1
    if (cam.near !== pose.near) {
      cam.near = pose.near;
      cam.updateProjectionMatrix();
    }
    const fov = cam.fov + (pose.fov - cam.fov) * Math.min(1, dt * 2);
    if (Math.abs(fov - cam.fov) > 0.001) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
