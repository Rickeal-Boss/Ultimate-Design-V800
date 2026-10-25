/**
 * 光照：DirectionalLight 主光（shadow 2048，正交 ±20 texel 对齐，bias −4e-4 / normalBias .03）
 * + HemisphereLight 环境补光 + 冷调无阴影补光 + rim 轮廓光。texel 对齐移植自原版 pg 的 update。
 *
 * R26：颜色/强度全部来自 `src/config/environment.ts` 的 ACTIVE_ENV（白石哥特教堂黄金时刻）。
 * **结构不动**：texel 对齐、补光反方位、rim 位置公式都是前几轮实拍验证过的，
 * 这里只换参数，不换结构 —— 改结构等于把之前验证过的阴影抖动/轮廓线结论全部作废。
 *
 * ── R31 阴影按需更新（N1 帧时 −60%）──────────────────────────────────────
 * 实测（.qa/r31_test/baseline.md §5.3）：冻结 `#noshadowupd` 后帧时 1467ms → 580ms（−60%），
 * 即「2048² 阴影每帧重绘」是当时最大的单项帧成本。本轮在**不碰 Game.ts**的前提下治理：
 *   ① `sun.shadow.autoUpdate = false` —— 关掉每帧自动重绘；
 *   ② `update(focus)` 里按 `quality.shadowUpdateInterval` 帧节流地置 `needsUpdate = true`；
 *   ③ 首次 update / 焦点跳变（>1.5m，复位或换场景）/ 外部 `forceShadowUpdate()` 强制刷新。
 * 关于拖影：阴影贴图是**正交**的且相机位置 texel 对齐（本文件既有 update 逻辑），
 * 节流期间贴图不更新 ⇒ 相当于阴影相机停在上一刷新帧的位置。焦点始终在 40m 正交盒内
 * （ortho 20 ⇒ ±20m），250km/h 下 2 帧位移 ≈2.3m ≪ 20m ⇒ 被投影物始终在盒内，
 * 深度也始终落在 [near=1, far=160]（光源沿 sunDirection 后退 60m）内 ⇒ **无可见拖影**。
 * （若出图对比发现拖影，把间隔调回 1 即可，见 .qa/r31_b/report.md。）
 */
import * as THREE from 'three';
import type { QualitySettings } from '../../config/quality';
import { ACTIVE_ENV } from '../../config/environment';

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly sunDirection: THREE.Vector3;
  private readonly fill: THREE.DirectionalLight;
  private readonly fillTarget = new THREE.Object3D();
  /** rim 轮廓光：冷白低角掠过车尾暗侧，勾一条轮廓亮线（无阴影，零额外开销） */
  private readonly rim: THREE.DirectionalLight;
  private readonly rimTarget = new THREE.Object3D();
  private readonly mapSize: number;
  private readonly ortho: number;
  /** R31：阴影更新间隔（帧）；1 = 每帧 */
  private readonly updateInterval: number;
  /** R31：焦点跳变阈值平方（1.5m²） */
  private readonly jumpSq = 1.5 * 1.5;
  private frame = 0;
  private readonly lastFocus = new THREE.Vector3();
  private hasFocus = false;
  private forceNext = true;
  private readonly basisX = new THREE.Vector3();
  private readonly basisY = new THREE.Vector3();
  private readonly aligned = new THREE.Vector3();

  constructor(scene: THREE.Scene, quality: QualitySettings, sunDirection: THREE.Vector3) {
    const preset = ACTIVE_ENV;
    this.mapSize = quality.shadowMapSize;
    this.ortho = quality.shadowOrtho;
    this.updateInterval = Math.max(1, Math.round(quality.shadowUpdateInterval));
    this.sunDirection = sunDirection.clone();

    // 环境补光：冷天光 + 地面暖反照。白石教堂靠这盏灯把背光面从「黑」托到「灰白」，
    // 所以 intensity 0.55（旧黄昏版 0.5）——背光面是白石的体积感来源，不是要被压掉的暗部。
    scene.add(new THREE.HemisphereLight(preset.hemi.sky, preset.hemi.ground, preset.hemi.intensity));

    const sun = new THREE.DirectionalLight(preset.sun.color, preset.sun.intensity);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.mapSize, this.mapSize);
    const cam = sun.shadow.camera;
    cam.left = -this.ortho;
    cam.right = this.ortho;
    cam.top = this.ortho;
    cam.bottom = -this.ortho;
    cam.near = 1;
    cam.far = 160;
    sun.shadow.bias = -4e-4;
    sun.shadow.normalBias = 0.03;
    // R31：关掉每帧自动重绘，改由 update() 按帧节流置 needsUpdate（见文件头 ① ② ③）
    sun.shadow.autoUpdate = false;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    // 冷调补光：与主光反方位、抬高入射角，无阴影（环境反射与暗部细节来源）
    this.fill = new THREE.DirectionalLight(preset.fill.color, preset.fill.intensity);
    this.fill.castShadow = false;
    scene.add(this.fill);
    scene.add(this.fillTarget);
    this.fill.target = this.fillTarget;

    // rim 轮廓光：冷白，从车后侧低角入射，掠过车身暗侧边缘形成一条冷光轮廓线。
    // 白石环境整体更亮，0.7 才既勾得出轮廓又不把暗侧提成灰（旧黑漆版 0.8）。
    this.rim = new THREE.DirectionalLight(preset.rim.color, preset.rim.intensity);
    this.rim.castShadow = false;
    scene.add(this.rim);
    scene.add(this.rimTarget);
    this.rim.target = this.rimTarget;

    // 阴影 texel 对齐的两个基向量（垂直于太阳方向）
    this.basisX.crossVectors(new THREE.Vector3(0, 1, 0), sunDirection).normalize();
    this.basisY.crossVectors(sunDirection, this.basisX).normalize();
  }

  /** 阴影相机 texel 对齐跟随，防止高速移动阴影抖动 */
  update(focus: THREE.Vector3): void {
    const texel = (this.ortho * 2) / this.mapSize;
    const ox = Math.round(focus.dot(this.basisX) / texel) * texel;
    const oy = Math.round(focus.dot(this.basisY) / texel) * texel;
    const oz = focus.dot(this.sunDirection);
    this.aligned
      .copy(this.basisX).multiplyScalar(ox)
      .addScaledVector(this.basisY, oy)
      .addScaledVector(this.sunDirection, oz);
    this.sun.position.copy(this.aligned).addScaledVector(this.sunDirection, 60);
    this.sun.target.position.copy(this.aligned);
    // 补光：反方位 + 抬高（不做阴影跟随，开销为零）
    this.fill.position.set(
      this.aligned.x - this.sunDirection.x * 50,
      this.aligned.y + 32,
      this.aligned.z - this.sunDirection.z * 50
    );
    this.fillTarget.position.copy(this.aligned);
    // rim 轮廓光：车后侧低角（+Z = 车尾方向，+X = 太阳反方位侧面），低高度掠射
    this.rim.position.set(
      this.aligned.x + 18,
      this.aligned.y + 3.5,
      this.aligned.z + 26
    );
    this.rimTarget.position.copy(this.aligned);

    // —— R31 阴影按需更新 —— 位置每帧都更新（便宜），但只有命中刷新条件的帧才重绘贴图。
    // 顺序有讲究：位置必须在「可能置 needsUpdate」之前写完，因为 three 在本次 render 的
    // 阴影 pass 里才读 position/target 算矩阵，这样刷新帧拿到的一定是最新焦点位置。
    this.frame += 1;
    const jumped = this.hasFocus && this.lastFocus.distanceToSquared(focus) > this.jumpSq;
    if (jumped || this.forceNext || this.frame % this.updateInterval === 0) {
      this.sun.shadow.needsUpdate = true;
      this.forceNext = false;
    }
    this.lastFocus.copy(focus);
    this.hasFocus = true;
  }

  /**
   * 外部强制刷新下一帧阴影（换场景 / 复位机位 / QA 探针用）。
   * 与 update() 内的节流条件并列，不互相覆盖。
   */
  forceShadowUpdate(): void {
    this.forceNext = true;
    this.sun.shadow.needsUpdate = true;
  }
}
