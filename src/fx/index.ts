/**
 * 特效系统（P3 实现）：轮胎烟 / 刹车痕 / 火花。
 * 统一生命周期：update / clear / dispose，与主循环解耦；
 * 按质量档开关：low 档全部关闭，medium 档池减半。
 * - TireSmoke：GPU 粒子（THREE.Points + ShaderMaterial，每粒子 alpha/size 属性），
 *   发射率 ∝ 机械制动强度 × 车速，烟色 dusk 暖灰粉，上升+扩散+淡出，池上限 600。
 * - SkidMarks：InstancedMesh 四轮刹车痕（512 段池），制动力超阈值按轮距贴地放置，
 *   用 MultiplyBlending + instanceColor 由深到白渐隐（到白 = 无痕迹），贴齐路面 y≈0.02。
 * - Sparks：brake_snap 瞬间爆发粒子（重力+衰减，AdditiveBlending），
 *   同时由 Game 触发 Postfx Flash 与慢动作（既有逻辑）。
 */
import * as THREE from 'three';
import type { QualityTier } from '../config/quality';

export interface FxModule {
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}

/**
 * 轮位（root 系偏移，x/z 单位 m）。
 * 与 createV800Model 的 wheel-fl/fr/rl/rr transform 对齐（x ±0.855 / z ±1.715，
 * 来自 object-sculpt-spec.json 实测值；R5 轮芯内收 0.875→0.855，胎外缘 0.9825 < 侧皮 1.003）。
 * 旧值 ±0.88 / ∓1.55 ±1.88 是已删除的
 * Car.ts buildWheel 口径，纵向偏差 16.5cm——旧 Car.ts 删除后此常量失去依据，特此更正。
 * 注意 carRoot（root）自身 identity，body.rotation.y = π 只影响渲染朝向，
 * fx 发射点直接加在 root.position 上，故此处写世界系偏移。
 */
const WHEEL_LOCAL: ReadonlyArray<readonly [number, number]> = [
  [-0.855, -1.715],
  [0.855, -1.715],
  [-0.855, 1.715],
  [0.855, 1.715]
];
/** 轮胎接地高度（路面 y=0） */
const CONTACT_Y = 0.02;

/** 每帧渲染的粒子着色器（圆形软边 + 每粒子 alpha/size） */
function makeParticleMaterial(color: number, additive: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aAlpha;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (160.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float a = smoothstep(0.5, 0.12, d) * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
  });
}

interface ParticlePool {
  points: THREE.Points;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  pos: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  baseSize: Float32Array;
  sizeAttr: Float32Array;
  alphaAttr: Float32Array;
  cursor: number;
}

function makePool(count: number, color: number, additive: boolean): ParticlePool {
  const geo = new THREE.BufferGeometry();
  const pool: ParticlePool = {
    points: null as unknown as THREE.Points,
    geo,
    mat: makeParticleMaterial(color, additive),
    pos: new Float32Array(count * 3),
    vel: new Float32Array(count * 3),
    life: new Float32Array(count),
    maxLife: new Float32Array(count),
    baseSize: new Float32Array(count),
    sizeAttr: new Float32Array(count),
    alphaAttr: new Float32Array(count),
    cursor: 0
  };
  geo.setAttribute('position', new THREE.BufferAttribute(pool.pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(pool.sizeAttr, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(pool.alphaAttr, 1));
  pool.points = new THREE.Points(geo, pool.mat);
  pool.points.frustumCulled = false;
  return pool;
}

function disposePool(pool: ParticlePool): void {
  pool.geo.dispose();
  pool.mat.dispose();
}

/* ------------------------------------------------------------------ */
/* 轮胎烟                                                              */
/* ------------------------------------------------------------------ */

export class TireSmoke implements FxModule {
  private pool: ParticlePool;
  private emitAcc = 0;

  constructor(poolSize: number) {
    // dusk 暖灰粉烟色
    this.pool = makePool(poolSize, 0xc4a49a, false);
  }

  get object(): THREE.Object3D {
    return this.pool.points;
  }

  /** 发射率 ∝ 机械制动强度 × 车速 */
  emit(origin: THREE.Vector3, speedMs: number, intensity: number, dt: number): void {
    const rate = 200 * intensity * Math.min(1, speedMs / 30) + 10 * intensity;
    this.emitAcc += rate * dt;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      this.spawn(origin, speedMs);
    }
  }

  private spawn(origin: THREE.Vector3, speedMs: number): void {
    const p = this.pool;
    const i = p.cursor;
    p.cursor = (p.cursor + 1) % (p.maxLife.length);
    const i3 = i * 3;
    const r = () => Math.random() * 2 - 1;
    p.pos[i3] = origin.x + r() * 0.22;
    p.pos[i3 + 1] = origin.y + Math.random() * 0.1;
    p.pos[i3 + 2] = origin.z + r() * 0.22;
    // 上升 + 随机扩散 + 轻微随车尾流后飘
    p.vel[i3] = r() * 0.7;
    p.vel[i3 + 1] = 0.8 + Math.random() * 1.2;
    p.vel[i3 + 2] = r() * 0.7 + Math.min(1.4, speedMs * 0.05);
    p.life[i] = 0;
    p.maxLife[i] = 0.9 + Math.random() * 0.8;
    p.baseSize[i] = 1.4 + Math.random() * 1.5;
  }

  update(dt: number): void {
    const p = this.pool;
    const n = p.maxLife.length;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      if (p.life[i] >= p.maxLife[i]) {
        p.alphaAttr[i] = 0;
        continue;
      }
      p.life[i] += dt;
      const drag = Math.exp(-dt * 1.6);
      p.vel[i3] *= drag;
      p.vel[i3 + 2] *= drag;
      p.vel[i3 + 1] += dt * 0.5; // 热浮力缓升
      p.pos[i3] += p.vel[i3] * dt;
      p.pos[i3 + 1] += p.vel[i3 + 1] * dt;
      p.pos[i3 + 2] += p.vel[i3 + 2] * dt;
      const t = p.life[i] / p.maxLife[i];
      p.alphaAttr[i] = Math.min(1, (1 - t) * 1.4) * Math.min(1, t * 8) * 0.5;
      p.sizeAttr[i] = p.baseSize[i] * (1 + t * 1.8); // 扩散
    }
    p.geo.attributes.position.needsUpdate = true;
    (p.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (p.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    const p = this.pool;
    p.life.fill(0);
    p.alphaAttr.fill(0);
    (p.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    disposePool(this.pool);
  }
}

/* ------------------------------------------------------------------ */
/* 刹车痕                                                              */
/* ------------------------------------------------------------------ */

export class SkidMarks implements FxModule {
  private mesh: THREE.InstancedMesh;
  private mat: THREE.MeshBasicMaterial;
  private geo: THREE.BufferGeometry;
  private ages: Float32Array;
  private cursor = 0;
  private readonly life = 7;
  private readonly dark = new THREE.Color(0.14, 0.13, 0.12);
  private readonly faded = new THREE.Color(1, 1, 1);
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private scaleOne = new THREE.Vector3(1, 1, 1);
  private vPos = new THREE.Vector3();
  private color = new THREE.Color();

  constructor(poolSize: number) {
    this.geo = new THREE.PlaneGeometry(0.3, 0.62);
    this.geo.rotateX(-Math.PI / 2);
    // MultiplyBlending：深色压暗路面，渐变回白 = 视觉消失，免逐实例透明度
    // premultipliedAlpha: true —— MultiplyBlending 需要，否则每帧刷 WebGLState 告警
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      blending: THREE.MultiplyBlending,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2
    });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, poolSize);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.ages = new Float32Array(poolSize).fill(-1);
    const colors = new Float32Array(poolSize * 3).fill(1);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < poolSize; i++) this.mesh.setMatrixAt(i, hide);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get object(): THREE.Object3D {
    return this.mesh;
  }

  /** 在轮位贴地放一段刹车痕，headingY 为车体航向角 */
  emit(x: number, z: number, headingY: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.ages.length;
    this.vPos.set(x, CONTACT_Y, z);
    this.q.setFromAxisAngle(UP, headingY);
    this.m4.compose(this.vPos, this.q, this.scaleOne);
    this.mesh.setMatrixAt(i, this.m4);
    this.ages[i] = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    const n = this.ages.length;
    let dirty = false;
    for (let i = 0; i < n; i++) {
      if (this.ages[i] < 0) continue;
      dirty = true;
      this.ages[i] += dt;
      const t = this.ages[i] / this.life;
      if (t >= 1) {
        this.ages[i] = -1;
        this.m4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m4);
        continue;
      }
      // 深色 → 白 = 渐隐
      this.color.copy(this.dark).lerp(this.faded, Math.min(1, t * 1.15));
      this.mesh.setColorAt(i, this.color);
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.ages.fill(-1);
    const hide = this.m4.makeScale(0, 0, 0);
    for (let i = 0; i < this.ages.length; i++) this.mesh.setMatrixAt(i, hide);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------------------ */
/* 火花                                                                */
/* ------------------------------------------------------------------ */

export class Sparks implements FxModule {
  private pool: ParticlePool;

  constructor(burstCount: number) {
    this.pool = makePool(burstCount, 0xffb050, true);
  }

  get object(): THREE.Object3D {
    return this.pool.points;
  }

  /** brake_snap / 撞击瞬间爆发 */
  burst(origin: THREE.Vector3, dirZ = -1): void {
    const p = this.pool;
    const n = p.maxLife.length;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      p.pos[i3] = origin.x;
      p.pos[i3 + 1] = origin.y;
      p.pos[i3 + 2] = origin.z;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 5 + 1;
      const spread = Math.random() * 3.5;
      p.vel[i3] = Math.cos(a) * spread;
      p.vel[i3 + 1] = up;
      p.vel[i3 + 2] = dirZ * (2 + Math.random() * 5) + Math.sin(a) * spread * 0.4;
      p.life[i] = 0;
      p.maxLife[i] = 0.45 + Math.random() * 0.45;
      p.baseSize[i] = 0.28 + Math.random() * 0.3;
      p.sizeAttr[i] = p.baseSize[i];
    }
    p.geo.attributes.position.needsUpdate = true;
    (p.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (p.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number): void {
    const p = this.pool;
    const n = p.maxLife.length;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      if (p.life[i] >= p.maxLife[i]) {
        p.alphaAttr[i] = 0;
        continue;
      }
      p.life[i] += dt;
      p.vel[i3 + 1] -= 12 * dt; // 重力
      p.pos[i3] += p.vel[i3] * dt;
      p.pos[i3 + 1] += p.vel[i3 + 1] * dt;
      p.pos[i3 + 2] += p.vel[i3 + 2] * dt;
      if (p.pos[i3 + 1] < CONTACT_Y) {
        p.pos[i3 + 1] = CONTACT_Y;
        p.vel[i3 + 1] *= -0.35; // 落地小反弹
      }
      const t = p.life[i] / p.maxLife[i];
      p.alphaAttr[i] = 1 - t;
    }
    p.geo.attributes.position.needsUpdate = true;
    (p.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    const p = this.pool;
    p.life.fill(0);
    p.alphaAttr.fill(0);
    (p.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    disposePool(this.pool);
  }
}

/* ------------------------------------------------------------------ */
/* 聚合器（Game 只接这一个门面）                                        */
/* ------------------------------------------------------------------ */

export interface FxFrameInput {
  carRoot: THREE.Object3D;
  /** 机械制动强度 0~1（pedalForce / breakForceN） */
  brakeIntensity: number;
  /** m/s */
  speedMs: number;
  braking: boolean;
}

export class FxSystems {
  private smoke: TireSmoke | null = null;
  private skid: SkidMarks | null = null;
  private sparks: Sparks | null = null;
  private skidTravel = [0, 0, 0, 0];
  private tmp = new THREE.Vector3();
  private fwd = new THREE.Vector3();

  constructor(scene: THREE.Scene, tier: QualityTier) {
    if (tier === 'low') return; // low 档全部关闭
    const scale = tier === 'high' ? 1 : 0.5;
    // 池容量按 200km/h 全力刹停标定：~171m / 0.8m 间隔 × 4 轮 ≈ 860 段，取 1200 留 1.4 倍余量
    this.smoke = new TireSmoke(Math.round(600 * scale));
    this.skid = new SkidMarks(Math.round(1200 * scale));
    this.sparks = new Sparks(Math.round(96 * scale));
    scene.add(this.smoke.object, this.skid.object, this.sparks.object);
  }

  update(dt: number, input: FxFrameInput): void {
    if (!this.smoke && !this.skid) return;
    const { carRoot, brakeIntensity, speedMs, braking } = input;
    const headingY = Math.atan2(
      this.fwd.set(0, 0, -1).applyQuaternion(carRoot.quaternion).x,
      this.fwd.z
    );
    for (let w = 0; w < WHEEL_LOCAL.length; w++) {
      const [lx, lz] = WHEEL_LOCAL[w];
      this.tmp.set(lx, CONTACT_Y, lz).applyQuaternion(carRoot.quaternion).add(carRoot.position);
      if (this.skid && braking && brakeIntensity > 0.35 && speedMs > 2.5) {
        // 每行驶 0.8m 铺一段痕（单帧单轮最多 2 段，防掉帧瞬间冲掉池）
        this.skidTravel[w] += speedMs * dt;
        let laid = 0;
        while (this.skidTravel[w] >= 0.8 && laid < 2) {
          this.skidTravel[w] -= 0.8;
          laid++;
          this.skid.emit(this.tmp.x, this.tmp.z, headingY);
        }
        if (laid > 0) this.skidTravel[w] = Math.min(this.skidTravel[w], 0.8);
      } else {
        this.skidTravel[w] = 0;
      }
      if (this.smoke && braking && brakeIntensity > 0.15 && speedMs > 3) {
        this.smoke.emit(this.tmp, speedMs, brakeIntensity, dt * 0.25); // 四轮各承担 1/4 发射率
      }
    }
    this.smoke?.update(dt);
    this.skid?.update(dt);
    this.sparks?.update(dt);
  }

  /** brake_snap 瞬间在车头位置爆发火花 */
  burstSparks(origin: THREE.Vector3): void {
    this.sparks?.burst(origin);
  }

  clear(): void {
    this.smoke?.clear();
    this.skid?.clear();
    this.sparks?.clear();
  }

  dispose(): void {
    this.smoke?.dispose();
    this.skid?.dispose();
    this.sparks?.dispose();
    this.smoke = null;
    this.skid = null;
    this.sparks = null;
  }
}
