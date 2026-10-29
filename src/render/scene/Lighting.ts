/**
 * 光照：DirectionalLight 主光（shadow 1024²，正交 ±10 texel 对齐，bias −4e-4 / normalBias .03）
 * + HemisphereLight 环境补光 + 冷调无阴影补光 + rim 轮廓光。texel 对齐移植自原版 pg 的 update。
 *
 * R26：颜色/强度全部来自 `src/config/environment.ts` 的 ACTIVE_ENV（白石哥特教堂黄金时刻）。
 * **结构不动**：texel 对齐、补光反方位、rim 位置公式都是前几轮实拍验证过的，
 * 这里只换参数，不换结构 —— 改结构等于把之前验证过的阴影抖动/轮廓线结论全部作废。
 *
 * ══ R39：阴影从「隔 N 帧重绘」改为「**每帧重绘**」（每帧成本恒定）══════════════
 * 为什么推翻 R31/R38 的节流方案：
 *   · 节流（`shadow.autoUpdate=false` + 每 N 帧 `needsUpdate`）在结构上必然产生
 *     **重帧/轻帧交替**：1 帧带阴影 pass、N−1 帧不带。用户主诉是「移动越快越跳帧」，
 *     而「交替」正是跳帧感的直接来源 —— 平均帧时再低也没用。
 *   · 更糟的是节流**还漏了**：旧 `jumpSq = 1.5²` 与车速无关，等价于「帧时 ≥ 1.5/v 秒
 *     就每帧判跳变」，200 km/h（55.56 m/s）下帧时 ≥27 ms（<37fps）即每帧误触。
 *     R39 探针实测（.qa/r39_perf，348 帧）：≥10 m/s 的三个速度桶 jump 命中率 **100%**，
 *     重绘节拍从设计的 4 帧塌到 **2 帧**（直方图 {2:146}，drew 占比 46~50% vs 设计 25%）。
 *     这是一条**速度→成本正反馈**：帧越长 ⇒ 越容易误触 ⇒ 重绘越频繁 ⇒ 帧更长。
 *   · 代价侧：把 ortho/mapSize 同比例减半（20/2048 → **10/1024**）后 texel 密度
 *     **逐位不变**（0.01953 m/texel），单次重绘成本 ∝ mapSize² ⇒ **÷4**。
 *     ⇒ 每帧 1 次 × C/4 == 旧方案每 4 帧 1 次 × C：**平均成本完全相同，交替归零**；
 *     相对「线上实际每 2 帧 1 次」连平均值也砍半。
 *   · 附带收益：不再有「阴影相机停在上一刷新帧」⇒ 高速下阴影相对车的滞后 4 帧
 *     （顶速 3.7m）归零，`ortho` 也不再需要为「陈旧位移」留量（详见 quality.ts 注释）。
 * 探针口径（`__r39perf`，DEV only）：`sun.shadow.needsUpdate` 在 three 真正画完该灯
 * 阴影后才清零（WebGLShadowMap.js:370）⇒「render 前 true + render 后 false」即本帧确实
 * 重绘；每帧重绘时该值应恒为真、drew 占比恒 100%。
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
  /**
   * QA/探针口径（R39）：update 调用次数。
   * 每帧重绘后不再有「命中哪条节流路径」可记；保留这一个计数只为让探针能算出
   * 「探针采样窗口内 Lighting 被调了几次」（校验探针与帧循环是否同频）。
   */
  readonly stats = { frames: 0 };
  private readonly basisX = new THREE.Vector3();
  private readonly basisY = new THREE.Vector3();
  private readonly aligned = new THREE.Vector3();

  constructor(scene: THREE.Scene, quality: QualitySettings, sunDirection: THREE.Vector3) {
    const preset = ACTIVE_ENV;
    this.mapSize = quality.shadowMapSize;
    this.ortho = quality.shadowOrtho;
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
    // R39：**每帧重绘**（结构上等价于 three 默认行为，显式写出以锁死契约：
    // 本文件不再有任何节流路径，任何后续改动都必须保持「每帧成本恒定」）。
    sun.shadow.autoUpdate = true;
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

    // R39：位置每帧更新 + 阴影每帧重绘（autoUpdate=true）⇒ 这一帧的成本里永远
    // 含一次阴影 pass，帧与帧之间没有「重/轻」差。`stats.frames` 供探针校验同频。
    this.stats.frames += 1;
  }

  /**
   * 外部强制刷新下一帧阴影（换场景 / 复位机位 / QA 探针用）。
   * R39 起 `autoUpdate=true` ⇒ 每帧本来就重绘，本方法已是**语义空操作**；
   * 保留它是为了不改 Game 侧的调用契约（换场景处仍在调用），并给未来若真需要
   * 重引入节流时留一个「强制刷一帧」的出口。
   */
  forceShadowUpdate(): void {
    this.sun.shadow.needsUpdate = true;
  }
}
