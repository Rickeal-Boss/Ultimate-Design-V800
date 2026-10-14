/**
 * 尊界V800 外观程序化装配（示意复刻，比例按真实尺寸 5495×2006×1850、轴距 3430）。
 * 双拼色（香槟金 #C9A86B 上半 + 深棕 #3E2F23 下半，公开报道资料）、
 * 封闭前脸 + 镀铬饰条 + 发光 MAEXTRO 字标、细长 LED 灯组、
 * 宫灯式纵向点阵尾灯 + 中央交互灯带 + 高位宽刹车灯、
 * 896 线激光雷达楔形块、双色后视镜、多辐轮圈 + 悬浮中心 Logo。
 * 车头朝 -Z（赛道方向）。
 *
 * P3 调光（材质与光照设计师·调光）：
 * - 车漆升级 MeshPhysicalMaterial + clearcoat（theme.ts 参数中枢）
 * - 玻璃按质量档分支：high/medium transmission / low opacity 降级
 * - emissive 联动：刹车灯平滑跟随踏板输入、brake_snap 闪红 API、
 *   刹车盘热辉光（brakeTemp）、头灯开关 API、交互灯带呼吸脉动
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeSafe } from '../../util/geo';
import { MATERIAL, PALETTE, makeGlassMaterial, makePaintMaterial } from '../../config/theme';
import type { QualityTier } from '../../config/quality';
import { damp } from '../../util/math';
import { canvasTexture, makeCanvas, paintNoise } from '../../util/canvasTex';

/** 尾灯宫灯点阵贴图（颜色贴图 → SRGB，由 canvasTexture 统一设置） */
function lanternTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(64, 256);
  ctx.fillStyle = '#180505';
  ctx.fillRect(0, 0, 64, 256);
  for (let y = 8; y < 248; y += 16) {
    for (let x = 8; x < 56; x += 16) {
      ctx.fillStyle = '#ff2a1e';
      ctx.beginPath();
      ctx.arc(x + 8, y + 8, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffb0a0';
      ctx.beginPath();
      ctx.arc(x + 8, y + 8, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return canvasTexture(canvas);
}

/** 轮毂悬浮 Logo 贴图（颜色贴图 → SRGB） */
function wheelLogoTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 128);
  ctx.fillStyle = '#101014';
  ctx.beginPath();
  ctx.arc(64, 64, 64, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e8d9a0';
  ctx.font = 'bold 30px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('V800', 64, 58);
  ctx.font = '16px sans-serif';
  ctx.fillText('MAEXTRO', 64, 88);
  return canvasTexture(canvas);
}

/** 车头发光字标贴图（颜色贴图 → SRGB） */
function grilleLogoTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(512, 128);
  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, 512, 128);
  paintNoise(ctx, 512, 128, 3000, 0.1);
  ctx.fillStyle = '#f2e6c8';
  ctx.font = 'bold 64px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#ffd980';
  ctx.shadowBlur = 18;
  ctx.fillText('MAEXTRO', 256, 70);
  return canvasTexture(canvas);
}

interface Wheel {
  holder: THREE.Group;
  spin: THREE.Group;
  logo: THREE.Mesh;
}

const BRAKE_IDLE = 1.6;
const BRAKE_FULL = 8;
const HEADLIGHT_ON = 3.2;
const HEADLIGHT_OFF = 0.12;

export class Car {
  readonly root = new THREE.Group();
  /** 车身俯仰/翻滚载体（crash 时由 World 接管 quaternion） */
  readonly body = new THREE.Group();
  readonly wheels: Wheel[] = [];
  private brakeLightMats: THREE.MeshStandardMaterial[] = [];
  private tailMat: THREE.MeshStandardMaterial;
  private barMat: THREE.MeshStandardMaterial;
  private headMat: THREE.MeshStandardMaterial;
  private discMat!: THREE.MeshStandardMaterial;
  /** 玻璃材质（质量档分档在构造时确定，低配档为 opacity 降级） */
  readonly glass: THREE.MeshPhysicalMaterial;
  private heat = 0;
  private wheelLogos: THREE.Mesh[] = [];
  private brakeTarget = BRAKE_IDLE;
  private brakeLevel = BRAKE_IDLE;
  private headTarget = HEADLIGHT_ON;
  private headLevel = HEADLIGHT_ON;
  private snapT = 0;
  private barTime = Math.random() * 10;
  /** 上一帧时刻（three r186 的 THREE.Clock 已废弃，改用 performance.now 差分） */
  private lastFrameTime = performance.now();
  /** 轮标朝向计算复用向量（P4：避免每帧 4 次 Vector3 分配） */
  private tmpWorld = new THREE.Vector3();

  constructor(tier: QualityTier = 'high') {
    const upper = makePaintMaterial(PALETTE.bodyUpper);
    const lower = makePaintMaterial(PALETTE.bodyLower, true);
    const chrome = new THREE.MeshStandardMaterial({ color: PALETTE.chrome, ...MATERIAL.chrome });
    const black = new THREE.MeshStandardMaterial({ color: PALETTE.blackPaint, roughness: 0.6, metalness: 0.3 });
    const glass = makeGlassMaterial(tier);
    this.glass = glass;
    const rubber = new THREE.MeshStandardMaterial({ color: PALETTE.rubber, ...MATERIAL.rubber });
    const rim = new THREE.MeshStandardMaterial({ color: PALETTE.darkMetal, ...MATERIAL.rim });

    this.root.add(this.body);

    // ---- 下半车体（深棕，清漆金属漆）----
    const lowerBody = new THREE.Mesh(new RoundedBoxGeometry(2.006, 0.92, 5.44, 3, 0.14), lower);
    lowerBody.position.set(0, 0.62, 0);
    lowerBody.castShadow = true;
    this.body.add(lowerBody);

    // ---- 上半车体（香槟金，悬浮式车顶）----
    const cabin = new THREE.Mesh(new RoundedBoxGeometry(1.9, 0.78, 3.9, 3, 0.18), upper);
    cabin.position.set(0, 1.42, 0.32);
    cabin.castShadow = true;
    this.body.add(cabin);

    // ---- 长车头封闭前脸 ----
    const hood = new THREE.Mesh(new RoundedBoxGeometry(1.96, 0.42, 1.3, 3, 0.1), upper);
    hood.position.set(0, 1.08, -2.1);
    hood.rotation.x = 0.05;
    hood.castShadow = true;
    this.body.add(hood);

    // 封闭格栅面板
    const grille = new THREE.Mesh(new RoundedBoxGeometry(1.82, 0.62, 0.16, 2, 0.06), lower);
    grille.position.set(0, 0.78, -2.7);
    this.body.add(grille);

    // 上沿粗镀铬饰条
    const chromeStrip = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.07, 0.06), chrome);
    chromeStrip.position.set(0, 1.12, -2.74);
    this.body.add(chromeStrip);

    // 中央发光 MAEXTRO 字标
    const logoTex = grilleLogoTexture();
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.26),
      new THREE.MeshStandardMaterial({
        color: 0x111111,
        emissive: 0xffffff,
        emissiveMap: logoTex,
        emissiveIntensity: 2.4,
        roughness: 0.4
      })
    );
    logo.position.set(0, 0.88, -2.79);
    logo.rotation.y = Math.PI;
    this.body.add(logo);

    // ---- 细长 LED 大灯（头灯联动 API：setHeadlights）----
    this.headMat = new THREE.MeshStandardMaterial({
      color: PALETTE.headlight,
      emissive: 0xeef4ff,
      emissiveIntensity: HEADLIGHT_ON
    });
    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.08), this.headMat);
      lamp.position.set(side * 0.68, 1.06, -2.76);
      lamp.rotation.z = side * 0.08;
      this.body.add(lamp);
    }

    // ---- 尾灯：两侧纵向宫灯点阵 + 中央交互灯带 + 高位宽刹车灯 ----
    this.tailMat = new THREE.MeshStandardMaterial({
      color: 0x3a0806,
      emissive: PALETTE.taillight,
      emissiveMap: lanternTexture(),
      emissiveIntensity: BRAKE_IDLE,
      roughness: 0.4
    });
    this.brakeLightMats.push(this.tailMat);
    for (const side of [-1, 1]) {
      const column = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.72, 0.06), this.tailMat);
      column.position.set(side * 0.86, 0.95, 2.73);
      this.body.add(column);
    }
    this.barMat = new THREE.MeshStandardMaterial({
      color: 0x081018,
      emissive: PALETTE.lightBar,
      emissiveIntensity: 2.4
    });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.04), this.barMat);
    bar.position.set(0, 1.16, 2.74);
    this.body.add(bar);
    const highBrakeMat = new THREE.MeshStandardMaterial({
      color: 0x220503,
      emissive: PALETTE.taillight,
      emissiveIntensity: BRAKE_IDLE
    });
    this.brakeLightMats.push(highBrakeMat);
    const highBrake = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.06), highBrakeMat);
    highBrake.position.set(0, 1.62, 2.68);
    this.body.add(highBrake);

    // ---- 挡风玻璃与侧窗（质量档分档：transmission / opacity）----
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.62, 0.06), glass);
    windshield.position.set(0, 1.46, -1.24);
    windshield.rotation.x = 0.42;
    windshield.renderOrder = 5;
    this.body.add(windshield);
    const rear = windshield.clone();
    rear.position.set(0, 1.48, 2.12);
    rear.rotation.x = -0.35;
    this.body.add(rear);
    for (const side of [-1, 1]) {
      const sideGlass = new THREE.Mesh(new RoundedBoxGeometry(0.04, 0.5, 3.3, 2, 0.02), glass);
      sideGlass.position.set(side * 0.955, 1.46, 0.34);
      sideGlass.renderOrder = 5;
      this.body.add(sideGlass);
    }

    // ---- A/B/C/D 柱（黑色饰条）----
    // P4 性能：8 根立柱合批为 1 个网格（同材质同尺寸，变换后 merge，视觉不变，省 7 DC）
    const pillarGeos: THREE.BufferGeometry[] = [];
    for (const [z, tilt] of [
      [-1.24, 0.42],
      [-0.3, 0],
      [1.15, 0],
      [2.12, -0.35]
    ] as const) {
      for (const side of [-1, 1]) {
        const pillarGeo = new THREE.BoxGeometry(0.05, 0.72, 0.09);
        pillarGeo.rotateX(tilt);
        pillarGeo.translate(side * 0.94, 1.45, z);
        pillarGeos.push(pillarGeo);
      }
    }
    this.body.add(new THREE.Mesh(mergeSafe(pillarGeos), black));

    // ---- 车顶 + 896 线激光雷达楔形块 ----
    const lidar = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.1, 0.34, 2, 0.03), black);
    lidar.position.set(0, 1.85, -0.9);
    this.body.add(lidar);

    // ---- 双色后视镜（上半镀铬下半车色）----
    for (const side of [-1, 1]) {
      const mirror = new THREE.Group();
      const mLower = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), lower);
      mLower.scale.set(1.1, 0.7, 1.6);
      const mUpper = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), chrome);
      mUpper.scale.set(1.05, 0.45, 1.5);
      mUpper.position.y = 0.045;
      mirror.add(mLower, mUpper);
      mirror.position.set(side * 1.08, 1.32, -1.15);
      this.body.add(mirror);
    }

    // ---- 门把手 4 组 + 翼子板镀铬小标识 ----
    // P4 性能：6 个镀铬小件合批为 1 个网格（省 5 DC）
    const chromeGeos: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      for (const z of [-0.7, 0.9]) {
        const handleGeo = new RoundedBoxGeometry(0.03, 0.045, 0.24, 2, 0.015);
        handleGeo.translate(side * 1.005, 1.08, z);
        chromeGeos.push(handleGeo);
      }
      const badgeGeo = new THREE.BoxGeometry(0.012, 0.05, 0.16);
      badgeGeo.translate(side * 1.004, 0.95, -1.7);
      chromeGeos.push(badgeGeo);
    }
    this.body.add(new THREE.Mesh(mergeSafe(chromeGeos), chrome));

    // ---- 四轮：255/55 R19 + 多辐轮圈（金属漆）+ 制动盘（热辉光）+ 悬浮 Logo ----
    const wheelLogoTex = wheelLogoTexture();
    for (const [x, z] of [
      [-0.88, -1.55],
      [0.88, -1.55],
      [-0.88, 1.88],
      [0.88, 1.88]
    ] as const) {
      this.wheels.push(this.buildWheel(x, z, rubber, rim, wheelLogoTex));
    }
  }

  private buildWheel(
    x: number,
    z: number,
    rubber: THREE.Material,
    rim: THREE.Material,
    logoTex: THREE.Texture
  ): Wheel {
    const holder = new THREE.Group();
    const spin = new THREE.Group();
    holder.add(spin);

    // 圆胎侧轮胎
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.382, 0.382, 0.255, 28), rubber);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    spin.add(tire);

    // 多辐轮圈（大饼样式，金属漆 metalness .9 / roughness .25）
    const rimMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.26, 20), rim);
    rimMesh.rotation.z = Math.PI / 2;
    spin.add(rimMesh);
    // 8 根辐条合批为 1 个网格（同材质，变换后 merge，视觉不变；4 轮共省 28 DC）
    const spokeGeos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const spokeGeo = new THREE.BoxGeometry(0.27, 0.34, 0.05);
      // 与原 Mesh 欧拉 XYZ 等价的几何变换顺序：先 Y 后 X，再平移
      spokeGeo.rotateY(Math.PI / 2);
      spokeGeo.rotateX((i / 8) * Math.PI);
      spokeGeo.translate(Math.sign(x) * 0.005, 0, 0);
      spokeGeos.push(spokeGeo);
    }
    spin.add(new THREE.Mesh(mergeSafe(spokeGeos), rim));

    // 制动盘（不随轮转的静态盘面 + emissive 热辉光，位于轮外侧可见）
    if (!this.discMat) {
      this.discMat = new THREE.MeshStandardMaterial({
        color: 0x3a3a3e,
        roughness: 0.45,
        metalness: 0.9,
        emissive: PALETTE.brakeDiscGlow,
        emissiveIntensity: 0
      });
    }
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.02, 24), this.discMat);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = Math.sign(x) * 0.135;
    holder.add(disc);

    // 悬浮中心 Logo（每帧面向相机、保持竖直）
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(0.14, 0.14),
      new THREE.MeshBasicMaterial({ map: logoTex, transparent: true })
    );
    logo.position.x = Math.sign(x) * 0.148;
    logo.rotation.y = Math.sign(x) > 0 ? Math.PI / 2 : -Math.PI / 2;
    holder.add(logo);
    this.wheelLogos.push(logo);

    holder.position.set(x, 0.382, z);
    this.body.add(holder);
    return { holder, spin, logo };
  }

  /** 车轮自转：dist 为本帧行驶距离 m，dt 帧时长（打滑视觉效果占位） */
  spinWheels(dist: number, dt: number): void {
    const angle = dist / 0.382;
    const d = Math.sign(angle) * Math.min(Math.abs(angle), 0.12);
    for (const w of this.wheels) w.spin.rotation.x -= d;
    void dt;
  }

  /**
   * 刹车灯联动入口：由渲染循环按踏板状态每帧传入目标强度。
   * 传入值经 update 钩子指数平滑——上升快（lambda 30，模拟踏板力爬升）、
   * 松开慢（lambda 7，灯组余辉），视觉上近似「emissive 随踏板力增强」。
   */
  setBrakeLights(intensity: number): void {
    this.brakeTarget = THREE.MathUtils.clamp(intensity, 0, BRAKE_FULL + 4);
  }

  /** brake_snap 瞬间闪红：由上层在断裂事件时调用一次（P3-A 预留 API） */
  flashBrakeSnap(): void {
    this.snapT = 1;
  }

  /** 头灯联动 API：ACCEL 段开启、BRAKE 段保持（上层按相位调用；默认开启） */
  setHeadlights(on: boolean): void {
    this.headTarget = on ? HEADLIGHT_ON : HEADLIGHT_OFF;
  }

  /** 制动盘热（0~1）：驱动盘面 emissive 热辉光，由 Game 每帧传入 brakeTemp */
  setBrakeHeat(t: number): void {
    this.heat = Math.max(0, t);
  }

  get currentHeat(): number {
    return this.heat;
  }

  /** 悬浮轮标面向相机 + 全部 emissive 联动的逐帧推进 */
  update(camera: THREE.Camera): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    // 刹车灯：指数平滑 + brake_snap 闪红增益
    this.snapT = Math.max(0, this.snapT - dt * 2.6);
    const lambda = this.brakeTarget > this.brakeLevel ? 30 : 7;
    this.brakeLevel = damp(this.brakeLevel, this.brakeTarget, lambda, dt);
    const tailIntensity = this.brakeLevel + this.snapT * this.snapT * 12;
    for (const mat of this.brakeLightMats) mat.emissiveIntensity = tailIntensity;

    // 头灯：平滑开关（避免瞬间跳变）
    this.headLevel = damp(this.headLevel, this.headTarget, 10, dt);
    this.headMat.emissiveIntensity = this.headLevel;

    // 制动盘热辉光：heat^1.6 曲线，低温不发光、过热橙红
    this.discMat.emissiveIntensity = Math.pow(this.heat, 1.6) * 5.5;

    // 中央交互灯带：缓慢呼吸脉动（吃到 Bloom）
    this.barTime += dt;
    this.barMat.emissiveIntensity = 2.3 + Math.sin(this.barTime * 2.6) * 0.5;

    for (const logo of this.wheelLogos) {
      const world = logo.getWorldPosition(this.tmpWorld);
      const dx = camera.position.x - world.x;
      const dz = camera.position.z - world.z;
      logo.rotation.y = Math.atan2(dx, dz);
    }
  }
}
