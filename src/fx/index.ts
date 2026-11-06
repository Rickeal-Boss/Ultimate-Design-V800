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
 *
 * ══ R51 Phase2-A · 方案 B「FX 空池零递交」════════════════════════════════════
 * R50 现状（Phase1 台账 §1.1）：非刹车段（占绝大多数帧）三个池全空，但
 *   · TireSmoke / Sparks 每帧遍历 600 / 96 槽位并恒置 3 个 attribute needsUpdate
 *     ⇒ 每帧 ≈14KB 全量 GPU 上传 + 2 个恒等 Points draw（frustumCulled=false）；
 *   · SkidMarks 的 1200 个 `scale(0,0,0)` 隐藏实例**仍整池递交**
 *     （`mesh.count` 未设、`frustumCulled=false`）⇒ 1 DC / 2,400 tri/帧纯空转。
 * 改法（**不削可见面、不降画质、不改任何发射/淡出公式**）：
 *   · 空池 `points.visible = false` / `mesh.visible = false` ⇒ 零 DC（不是「0 实例的
 *     空 draw」：three 的 `renderInstances(..., count=0)` 仍是一次 GL 调用，故必须靠
 *     `visible` 才真零 DC；`mesh.count = 0` 只作第二道保险 + tri 口径对齐）；
 *   · 稳态空池快速返回 ⇒ 零遍历、零 attribute 上传；
 *   · 最后一个粒子死亡的那一帧仍上传一次把 alpha/instanceMatrix 清零，避免残影。
 * 回滚：`#r51fxidle=off` ⇒ FX_IDLE_GATE=false ⇒ 逐位回 R50 恒定全量递交。
 * ⚠ InstancedMesh 口径：tri = geometry tri × `mesh.count`；探针统计整帧 tri 时须
 *   手工乘 count 或跳过（bbox/顶点未乘 instanceMatrix，主理人铁律）。
 */
import * as THREE from 'three';
import type { QualityTier } from '../config/quality';
import { isR51FxIdleEnabled } from '../config/r51Perf';

/** R51-B：模块加载期读一次 hash（与 config/motionBlur.ts 的 cached 同款），热路径零判定 */
const FX_IDLE_GATE = isR51FxIdleEnabled();

export interface FxModule {
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}

/**
 * 轮位（root 系偏移，x/z 单位 m）。
 * 默认值与 createV800Model 的 wheel-fl/fr/rl/rr transform 对齐（x ±0.855 / z ±1.715，
 * 来自 object-sculpt-spec.json 实测值；R5 轮芯内收 0.875→0.855，胎外缘 0.9825 < 侧皮 1.003）。
 * 旧值 ±0.88 / ∓1.55 ±1.88 是已删除的
 * Car.ts buildWheel 口径，纵向偏差 16.5cm——旧 Car.ts 删除后此常量失去依据，特此更正。
 * 注意 carRoot（root）自身 identity，body.rotation.y = π 只影响渲染朝向，
 * fx 发射点直接加在 root.position 上，故此处写世界系偏移。
 *
 * R44：外部壳装载成功后，适配器经 {@link setFxWheelOffsets} 把四轮位改写成
 * 外部 hub × scale 的世界系偏移（每车不同：V800 轴距 3.47m / R7 2.95m），
 * 未装载时保持程序化默认值，切换车 = Game 重建装配 = 重设一次。
 */
const WHEEL_LOCAL_DEFAULT: ReadonlyArray<readonly [number, number]> = [
  [-0.855, -1.715],
  [0.855, -1.715],
  [-0.855, 1.715],
  [0.855, 1.715]
];
let WHEEL_LOCAL: ReadonlyArray<readonly [number, number]> = WHEEL_LOCAL_DEFAULT;

/** R44：适配器在外部壳装载成功后同步四轮世界系偏移（fl/fr/rl/rr 顺序） */
export function setFxWheelOffsets(offsets: ReadonlyArray<readonly [number, number]>): void {
  if (offsets.length === 4) WHEEL_LOCAL = offsets;
}

/** QA/测试用：恢复程序化默认轮位 */
export function resetFxWheelOffsets(): void {
  WHEEL_LOCAL = WHEEL_LOCAL_DEFAULT;
}
/** 轮胎接地高度（路面 y=0） */
const CONTACT_Y = 0.02;

/**
 * R46 ④：原 `TireSmoke.spawn` 每发射 1 个粒子就 `new` 一个箭头闭包
 * （全力刹车 ≈ 210 粒子/s/轮 × 4 轮 ≈ 840 个/秒，R43 定性 GC 29.3ms/轮是唯一真尖峰）。
 * 提到模块级后随机调用次序逐位不变 ⇒ 行为零差异，纯削分配。
 */
function randSigned(): number {
  return Math.random() * 2 - 1;
}

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
  /** R51-B：true = 池内仍有活粒子或本帧刚 spawn；false = 稳态空池（零遍历/零上传/零 DC） */
  private active = false;

  constructor(poolSize: number) {
    // dusk 暖灰粉烟色
    this.pool = makePool(poolSize, 0xc4a49a, false);
    if (FX_IDLE_GATE) this.pool.points.visible = false;
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
    p.pos[i3] = origin.x + randSigned() * 0.22;
    p.pos[i3 + 1] = origin.y + Math.random() * 0.1;
    p.pos[i3 + 2] = origin.z + randSigned() * 0.22;
    // 上升 + 随机扩散 + 轻微随车尾流后飘
    p.vel[i3] = randSigned() * 0.7;
    p.vel[i3 + 1] = 0.8 + Math.random() * 1.2;
    p.vel[i3 + 2] = randSigned() * 0.7 + Math.min(1.4, speedMs * 0.05);
    p.life[i] = 0;
    p.maxLife[i] = 0.9 + Math.random() * 0.8;
    p.baseSize[i] = 1.4 + Math.random() * 1.5;
    this.active = true;
  }

  update(dt: number): void {
    const p = this.pool;
    /* R51-B：稳态空池直接返回 —— 零循环、零 attribute 上传、零 draw call。
     * `#r51fxidle=off` ⇒ 本分支恒不成立，逐位回 R50。 */
    if (FX_IDLE_GATE && !this.active) {
      if (p.points.visible) p.points.visible = false;
      return;
    }
    const n = p.maxLife.length;
    let live = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      if (p.life[i] >= p.maxLife[i]) {
        p.alphaAttr[i] = 0;
        continue;
      }
      live++;
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
    if (FX_IDLE_GATE) {
      // 最后一个粒子死亡：本帧仍上传一次（上面 3 行）把 alpha 清零，之后归零态
      if (live === 0) {
        this.active = false;
        p.points.visible = false;
      } else if (!p.points.visible) {
        p.points.visible = true;
      }
    }
  }

  clear(): void {
    const p = this.pool;
    p.life.fill(0);
    p.alphaAttr.fill(0);
    (p.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    if (FX_IDLE_GATE) {
      this.active = false;
      p.points.visible = false;
    }
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
    /* R51-B：空池零递交。count=0 ⇒ 0 tri；visible=false ⇒ 真零 DC
     * （three 对 count=0 的 InstancedMesh 仍会发一次 renderInstances，只有 visible 能跳过）。
     * 矩阵初始化（上面的 hide 循环）保留：首次 emit 抬高 count 时不会读到未初始化的 GPU 数据。 */
    this.mesh.count = FX_IDLE_GATE ? 0 : poolSize;
    if (FX_IDLE_GATE) this.mesh.visible = false;
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
    // count = 已写过的最高索引 + 1（ring buffer 回绕后恒为池容量，与 R50 全量递交一致）
    this.mesh.count = Math.min(this.ages.length, Math.max(this.mesh.count, i + 1));
    if (FX_IDLE_GATE) this.mesh.visible = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    // R51-B：空池稳态零遍历（count=0 且 visible=false 时不进循环）
    if (FX_IDLE_GATE && !this.mesh.visible) return;
    const n = this.ages.length;
    let dirty = false;
    let alive = 0;
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
      alive++;
      // 深色 → 白 = 渐隐
      this.color.copy(this.dark).lerp(this.faded, Math.min(1, t * 1.15));
      this.mesh.setColorAt(i, this.color);
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
    // 最后一段痕淡出：本帧仍上传隐藏矩阵（上面 if(dirty)），之后整池归零态
    if (FX_IDLE_GATE && alive === 0) this.mesh.visible = false;
  }

  clear(): void {
    this.ages.fill(-1);
    const hide = this.m4.makeScale(0, 0, 0);
    for (let i = 0; i < this.ages.length; i++) this.mesh.setMatrixAt(i, hide);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = FX_IDLE_GATE ? 0 : this.ages.length;
    if (FX_IDLE_GATE) this.mesh.visible = false;
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
  /** R51-B：同 TireSmoke */
  private active = false;

  constructor(burstCount: number) {
    this.pool = makePool(burstCount, 0xffb050, true);
    if (FX_IDLE_GATE) this.pool.points.visible = false;
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
    this.active = true;
    p.geo.attributes.position.needsUpdate = true;
    (p.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (p.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number): void {
    const p = this.pool;
    // R51-B：稳态空池零遍历 / 零上传 / 零 DC
    if (FX_IDLE_GATE && !this.active) {
      if (p.points.visible) p.points.visible = false;
      return;
    }
    const n = p.maxLife.length;
    let live = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      if (p.life[i] >= p.maxLife[i]) {
        p.alphaAttr[i] = 0;
        continue;
      }
      live++;
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
    if (FX_IDLE_GATE) {
      if (live === 0) {
        this.active = false;
        p.points.visible = false;
      } else if (!p.points.visible) {
        p.points.visible = true;
      }
    }
  }

  clear(): void {
    const p = this.pool;
    p.life.fill(0);
    p.alphaAttr.fill(0);
    (p.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    if (FX_IDLE_GATE) {
      this.active = false;
      p.points.visible = false;
    }
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
      // R46 ④：索引访问代替数组解构（原每帧 4 次迭代器分配）
      const wheel = WHEEL_LOCAL[w];
      const lx = wheel[0];
      const lz = wheel[1];
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
