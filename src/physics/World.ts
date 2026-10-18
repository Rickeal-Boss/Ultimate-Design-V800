/**
 * cannon-es 世界封装（仅碰撞/翻滚用——纵向动力学走 Vehicle 纯函数）。
 * 撞路障翻滚：刚体台车 + 分段静态地面 + 分段护栏 + 路障块（撞路障时激活为动态刚体）。
 *
 * R14 分段世界（修「翻滚出桥外不掉下去」）：旧实现是一个无限 Plane @ y=0 +
 * 两侧 600m 静态长墙 —— 车在任何位置都不会坠落。现在按河谷几何铺静态盒：
 *   · 北岸段（z ≥ −370）/ 南岸段（z ≤ −530）：整幅地面，顶面 y=0
 *   · 桥面段（z −530..−370）：只有 x ±7.0 的窄条（顶面 y=0），两侧 0.5m 矮墙
 *   · 河床：x ±150 / z ±80 的大盒，顶面 y=−5.6
 * 车翻过桥侧矮墙 → 自由落体 4.4m 入水 → 阻尼 + 半浮力 → 沉底静止。
 *
 * 玩法改版（决策①）：踏板断裂不再翻滚 —— 冗余制动接管至停车，翻滚只留给撞路障，
 * 故 `brake_snap` 分支与其「凭空赋予侧向+翻转角速度」的能量来源问题一并删除。
 */
import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { GRAVITY, TRACK, VEHICLE } from '../config/physics';

/** 水面 y（与 render/scene/Road.ts 的 RIVER.waterY 同源，改动必须同步） */
const WATER_Y = -4.4;
/** 河谷开槽（与 Road.RIVER 同源） */
const RIVER_CENTER_Z = -450;
const RIVER_HOLE_HALF_Z = 80;
/** 桥面窄条半宽（视觉桥面 ±7.4，留 0.4m 让车能压在边沿并翻出去） */
const DECK_HALF_X = 7.0;

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
 * 与车模实测包围盒对齐（R11 终波鼻面压缩后）：车宽 2.006 → 半宽 1.003（取 1.01），
 * 车高 1.85 → 半高 0.925（取 0.92），车长 5.189 → 半长 2.595（取 2.60）。
 * 视觉车体 z 范围 −2.821..+2.368（几何中心偏后 −0.2265），台车盒经
 * addShape 偏移精确对位（CAR_BOX_Z_OFFSET），前后覆盖误差 <1cm——
 * 原居中近似盒在鼻面压缩后前端悬空 0.29m，会读作"车头未及就撞"。
 */
const HALF_EXTENTS = new CANNON.Vec3(1.01, 0.92, 2.6);
const CAR_BODY_Y = 0.95;
const CAR_BOX_Z_OFFSET = -0.2265;

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
  /** 落水浮力（复用，避免逐帧分配） */
  private readonly buoyancyV = new CANNON.Vec3();
  /** 是否已入水（只做一次阻尼切换） */
  private submerged = false;
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
   * @param speedMs 撞击瞬间的车速 m/s
   * @param barrierMeshes 路障块网格（转为动态刚体）
   */
  begin(carRoot: THREE.Object3D, speedMs: number, barrierMeshes: THREE.Object3D[]): void {
    this.reset();
    this.active = true;
    this.time = 0;

    // 审查修复（B-3）：重力引用统一常量（原硬编码 9.82 与 GRAVITY 9.81 不一致）
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
    world.allowSleep = true;
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.defaultContactMaterial.friction = 0.42;
    world.defaultContactMaterial.restitution = 0.18;
    this.world = world;

    // 分段静态世界（见文件头）：全部用 Box，SAP broadphase 下长条盒开销可忽略
    const addStatic = (hx: number, hy: number, hz: number, x: number, y: number, z: number): void => {
      const body = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(hx, hy, hz)),
        position: new CANNON.Vec3(x, y, z)
      });
      world.addBody(body);
    };
    const holeNear = RIVER_CENTER_Z + RIVER_HOLE_HALF_Z; // -370
    const holeFar = RIVER_CENTER_Z - RIVER_HOLE_HALF_Z; // -530
    // 北岸 / 南岸整幅地面（顶面 y=0）
    addStatic(1500, 0.5, (2130 - holeNear) / 2, 0, -0.5, (2130 + holeNear) / 2);
    addStatic(1500, 0.5, (holeFar + 3870) / 2, 0, -0.5, (holeFar - 3870) / 2);
    // 桥面窄条（只有 ±7m 宽 —— 越界即坠落）
    addStatic(DECK_HALF_X, 0.4, RIVER_HOLE_HALF_Z, 0, -0.4, RIVER_CENTER_Z);
    // 河床（落水后的承接面）
    addStatic(150, 0.6, RIVER_HOLE_HALF_Z, 0, -6.2, RIVER_CENTER_Z);

    // 护栏：北岸 / 南岸两段（桥段只有 0.5m 矮墙，可以被翻越）
    const sideX = TRACK.roadWidth / 2 + 1.1;
    for (const side of [-1, 1]) {
      addStatic(0.1, 0.42, (260 - holeNear) / 2, side * sideX, 0.42, (260 + holeNear) / 2);
      addStatic(0.1, 0.42, (holeFar + 2000) / 2, side * sideX, 0.42, (holeFar - 2000) / 2);
      // 桥侧矮墙：0.5m 高，车体 1.85m 高、翻滚时可以越出
      addStatic(0.16, 0.25, RIVER_HOLE_HALF_Z, side * 7.3, 0.25, RIVER_CENTER_Z);
    }

    // 台车（撞路障时动态路障块一起激活）；盒体带 z 偏移精确对位视觉车体中心
    const car = new CANNON.Body({
      mass: VEHICLE.totalMassKg,
      position: new CANNON.Vec3(carRoot.position.x, CAR_BODY_Y, carRoot.position.z),
      linearDamping: 0.04,
      angularDamping: 0.08
    });
    car.addShape(new CANNON.Box(HALF_EXTENTS), new CANNON.Vec3(0, 0, CAR_BOX_Z_OFFSET));
    car.quaternion.set(
      carRoot.quaternion.x,
      carRoot.quaternion.y,
      carRoot.quaternion.z,
      carRoot.quaternion.w
    );
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
    const body = this.carBody;
    // 落水：水面以下给 55% 浮力 + 强阻尼 —— 有水感（下沉变慢、翻滚被吃掉），
    // 但净重力仍向下 45%，最终沉在河床上静止，不会漂走。
    if (body.position.y < WATER_Y + 0.3) {
      if (!this.submerged) {
        this.submerged = true;
        body.linearDamping = 0.86;
        body.angularDamping = 0.94;
      }
      this.buoyancyV.set(0, body.mass * GRAVITY * 0.55, 0);
      body.applyForce(this.buoyancyV);
    } else if (this.submerged) {
      this.submerged = false;
      body.linearDamping = 0.04;
      body.angularDamping = 0.08;
    }
    this.world.step(1 / 120, dt, 10);
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
    this.submerged = false;
    this.time = 0;
  }

  dispose(): void {
    this.reset();
    void this.scene;
  }
}
