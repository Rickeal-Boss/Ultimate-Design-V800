/**
 * cannon-es 世界封装（仅碰撞/翻滚用——纵向动力学走 Vehicle 纯函数）。
 * 撞车/断裂翻滚：刚体台车 + 地面 + 两侧护栏 + 路障块（仅撞路障时激活）。
 * P2 范围：不含车轮 detach 与碎片（P3 补充），翻滚动画本身为真物理。
 */
import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { VEHICLE } from '../config/physics';
import { TRACK } from '../config/physics';

export type CrashReason = 'barrier' | 'brake_snap';

export interface CrashImpact {
  strength: number; // 0~1
  position: THREE.Vector3;
}

interface BarrierPair {
  mesh: THREE.Object3D;
  body: CANNON.Body;
}

/**
 * 台车碰撞盒半尺寸（x=半宽 / y=半高 / z=半长）。
 * 与车模实测包围盒对齐：车宽 2.006 → 半宽 1.003，车高 1.85 → 半高 0.925，
 * 车长 5.495 → 半长 2.748（z 保守取 2.66，保持撞障点回归数值不变）。
 * 原半宽 1.1 比车宽半值 1.003 宽 9.7%，视觉上车体还没贴到路障就已判定碰撞。
 */
const HALF_EXTENTS = new CANNON.Vec3(1.01, 0.92, 2.66);
const CAR_BODY_Y = 0.95;

export class World {
  private scene: THREE.Scene;
  private world: CANNON.World | null = null;
  private carBody: CANNON.Body | null = null;
  private carRoot: THREE.Object3D | null = null;
  private barriers: BarrierPair[] = [];
  private barrierHome = new Map<THREE.Object3D, { p: THREE.Vector3; q: THREE.Quaternion }>();
  private time = 0;
  private lastImpactAt = 0;
  /** P4：crash 段每帧复用向量，避免逐帧分配 */
  private downV = new THREE.Vector3();
  private focusV = new THREE.Vector3();
  active = false;

  constructor(
    scene: THREE.Scene,
    private onImpact: (impact: CrashImpact) => void
  ) {
    this.scene = scene;
  }

  /**
   * 开始一次翻滚模拟。
   * @param carRoot 车模根节点（其 position/quaternion 会被物理接管）
   * @param reason 撞车原因（brake_snap 时给侧向+翻转角速度；barrier 时顶起前翻）
   * @param speedMs 撞击瞬间的车速 m/s
   * @param barrierMeshes 路障块网格（撞路障时转为动态刚体）
   */
  begin(
    carRoot: THREE.Object3D,
    reason: CrashReason,
    speedMs: number,
    barrierMeshes: THREE.Object3D[]
  ): void {
    this.reset();
    this.active = true;
    this.time = 0;

    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    world.allowSleep = true;
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.defaultContactMaterial.friction = 0.42;
    world.defaultContactMaterial.restitution = 0.18;
    this.world = world;

    // 地面
    const ground = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(ground);

    // 两侧护栏
    const sideX = TRACK.roadWidth / 2 + 1.1;
    for (const side of [-1, 1]) {
      const wall = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(0.1, 0.42, 300)),
        position: new CANNON.Vec3(side * sideX, 0.42, carRoot.position.z - 250)
      });
      world.addBody(wall);
    }

    // 台车（撞路障时动态路障块一起激活）
    const car = new CANNON.Body({
      mass: VEHICLE.totalMassKg,
      shape: new CANNON.Box(HALF_EXTENTS),
      position: new CANNON.Vec3(carRoot.position.x, CAR_BODY_Y, carRoot.position.z),
      linearDamping: 0.04,
      angularDamping: 0.08
    });
    car.quaternion.set(
      carRoot.quaternion.x,
      carRoot.quaternion.y,
      carRoot.quaternion.z,
      carRoot.quaternion.w
    );
    if (reason === 'brake_snap') {
      const e = Math.min(1, speedMs / 50);
      car.velocity.set(2.6 * e, 4.8 * e + 1.5, -speedMs * 0.9);
      car.angularVelocity.set(-1.6 * e, 0.9 * e, 5.6 * e + 1.2);
    } else {
      car.velocity.set(0, 1.2, -speedMs);
      car.angularVelocity.set(-0.6, 0.3, 1.6);
      for (const mesh of barrierMeshes) {
        this.barrierHome.set(mesh, { p: mesh.position.clone(), q: mesh.quaternion.clone() });
        const block = new CANNON.Body({
          mass: 650,
          shape: new CANNON.Box(new CANNON.Vec3(0.95, 0.5, 0.35)),
          position: new CANNON.Vec3(mesh.position.x, mesh.position.y, mesh.position.z)
        });
        world.addBody(block);
        this.barriers.push({ mesh, body: block });
      }
    }
    car.addEventListener('collide', (event: { contact: CANNON.ContactEquation }) => {
      const impact = Math.abs(event.contact.getImpactVelocityAlongNormal());
      if (impact < 2.5 || this.time - this.lastImpactAt < 0.12) return;
      this.lastImpactAt = this.time;
      const strength = Math.min(1, impact / 14);
      this.onImpact({
        strength,
        position: new THREE.Vector3(car.position.x, car.position.y, car.position.z)
      });
    });
    world.addBody(car);
    this.carBody = car;
    this.carRoot = carRoot;
  }

  /** 每渲染帧推进（dt 已含慢动作缩放） */
  update(dt: number): void {
    if (!this.active || !this.world || !this.carBody || !this.carRoot) return;
    this.time += dt;
    this.world.step(1 / 120, dt, 10);
    const body = this.carBody;
    this.carRoot.quaternion.set(
      body.quaternion.x,
      body.quaternion.y,
      body.quaternion.z,
      body.quaternion.w
    );
    // 台车碰撞盒中心在半高以上，落回车模原点
    const down = this.downV.set(0, -CAR_BODY_Y, 0).applyQuaternion(this.carRoot.quaternion);
    this.carRoot.position.set(body.position.x + down.x, body.position.y + down.y, body.position.z + down.z);
    for (const { mesh, body: b } of this.barriers) {
      mesh.position.set(b.position.x, b.position.y, b.position.z);
      mesh.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    }
  }

  /** 翻滚中的车速 m/s（HUD 显示用） */
  get carSpeed(): number {
    return this.carBody ? this.carBody.velocity.length() : 0;
  }

  /** 翻滚焦点（相机跟随）。返回复用向量，调用方不得持有引用 */
  get focus(): THREE.Vector3 {
    if (!this.carBody) return this.focusV.set(0, 0, 0);
    return this.focusV.set(this.carBody.position.x, this.carBody.position.y, this.carBody.position.z);
  }

  reset(): void {
    for (const { mesh } of this.barriers) {
      const home = this.barrierHome.get(mesh);
      if (home) {
        mesh.position.copy(home.p);
        mesh.quaternion.copy(home.q);
      }
    }
    this.barriers = [];
    this.barrierHome.clear();
    this.world = null;
    this.carBody = null;
    this.carRoot = null;
    this.active = false;
    this.time = 0;
  }

  dispose(): void {
    this.reset();
    void this.scene;
  }
}
