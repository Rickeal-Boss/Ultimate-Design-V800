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

export type CameraMode = 'orbit' | 'chase' | 'hood' | 'cabin' | 'side' | 'crash';

/** V 键在 ACCEL/BRAKE 段可循环的视角（orbit 仅供菜单/结算） */
export const CYCLE_VIEWS: readonly CameraMode[] = ['chase', 'hood', 'cabin', 'side'];

interface ModePose {
  offset: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
  /** 偏移追踪刚度 */
  k: number;
  /** 锚点跟随刚度（车内/机盖需要紧贴车体） */
  anchorK: number;
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
  anchorK: 5,
  near: 0.1,
  local: false
};

const MODES: Record<CameraMode, (speed: number, portrait: boolean, time: number) => void> = {
  orbit: (_speed, portrait, time) => {
    const radius = portrait ? 9.5 : 7.8;
    POSE.offset.set(Math.sin(time * 0.16) * radius, portrait ? 2.4 : 1.5, Math.cos(time * 0.16) * radius);
    POSE.look.set(0, portrait ? -1.6 : 0.85, 0);
    POSE.fov = portrait ? 58 : 42;
    POSE.k = 2;
    POSE.anchorK = 5;
    POSE.near = 0.1;
    POSE.local = false;
  },
  chase: (speed) => {
    // 动态 FOV：55 → 68 随速度
    const e = Math.min(speed / 72, 1);
    POSE.offset.set(1.6 - e * 1.2, 2.2 - e * 0.5, 8.2 - e * 1.4);
    POSE.look.set(0, 1, -6);
    POSE.fov = 55 + e * 13;
    POSE.k = 2.5;
    POSE.anchorK = 5;
    POSE.near = 0.1;
    POSE.local = false;
  },
  hood: () => {
    // 引擎盖正上方（风挡玻璃之外），向前略俯视路面
    POSE.offset.set(0, 1.45, -1.45);
    POSE.look.set(0, 0.95, -16);
    POSE.fov = 66;
    POSE.k = 4;
    POSE.anchorK = 30;
    POSE.near = 0.1;
    POSE.local = true;
  },
  cabin: () => {
    // 驾驶位头枕前方（左舵 x=-0.55），目高 1.15m；视野覆盖三联屏/方向盘/星环/中岛
    POSE.offset.set(-0.55, 1.16, -0.45);
    POSE.look.set(-0.42, 1.12, -10);
    POSE.fov = 68;
    POSE.k = 4;
    POSE.anchorK = 30;
    POSE.near = 0.05;
    POSE.local = true;
  },
  side: () => {
    // 车侧平行跟拍机位
    POSE.offset.set(4.6, 1.5, 0.6);
    POSE.look.set(0, 0.85, -0.6);
    POSE.fov = 45;
    POSE.k = 3;
    POSE.anchorK = 8;
    POSE.near = 0.1;
    POSE.local = true;
  },
  crash: () => {
    POSE.offset.set(9, 4.5, 13);
    POSE.look.set(0, 0, 0);
    POSE.fov = 55;
    POSE.k = 2.2;
    POSE.anchorK = 5;
    POSE.near = 0.1;
    POSE.local = false;
  }
};

const IDENT = new THREE.Quaternion();

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'orbit';
  private shake = 0;
  private time = 0;
  private offset = new THREE.Vector3(6, 1.6, 6);
  private lookOffset = new THREE.Vector3(0, 0.85, 0);
  private anchor = new THREE.Vector3();
  private anchorReady = false;
  private tmpOffset = new THREE.Vector3();
  private tmpLook = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 12000);
    this.camera.position.copy(this.offset);
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  addShake(amount: number): void {
    this.shake = Math.max(this.shake, amount);
  }

  update(dt: number, target: THREE.Vector3, speed: number, carQuat: THREE.Quaternion = IDENT): void {
    const cam = this.camera;
    const portrait = cam.aspect < 1;
    this.time += dt;
    MODES[this.mode](speed, portrait, this.time);
    const pose = POSE;

    // 局部视角（hood/cabin/side）偏移随车体朝向旋转
    const q = pose.local ? carQuat : IDENT;
    const off = this.tmpOffset.copy(pose.offset).applyQuaternion(q);
    const look = this.tmpLook.copy(pose.look).applyQuaternion(q);

    if (!this.anchorReady || this.mode === 'crash') {
      this.anchor.copy(target);
      this.anchorReady = true;
    } else {
      this.anchor.lerp(target, 1 - Math.exp(-dt * pose.anchorK));
    }
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
