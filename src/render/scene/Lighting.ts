/**
 * 光照：DirectionalLight 主光（shadow 2048，正交 ±28 texel 对齐，bias −4e-4 / normalBias .03）
 * + HemisphereLight 环境补光 + 冷调无阴影补光。texel 对齐移植自原版 pg 的 update。
 *
 * P3 调光（黄昏基调）：
 * - 主光暖色低角度（~4500K 观感，0xffd2a2 / 3.3）
 * - 半球光冷调平衡：天空冷蓝灰 + 地面暖反照
 * - 追加一盏冷调补光（无阴影，零额外阴影开销），防止暗部死黑
 */
import * as THREE from 'three';
import type { QualitySettings } from '../../config/quality';

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly sunDirection: THREE.Vector3;
  private readonly fill: THREE.DirectionalLight;
  private readonly fillTarget = new THREE.Object3D();
  /** P0-3 rim 轮廓光：冷白低角掠过车尾暗侧，勾一条轮廓亮线（无阴影，零额外开销） */
  private readonly rim: THREE.DirectionalLight;
  private readonly rimTarget = new THREE.Object3D();
  private readonly mapSize: number;
  private readonly ortho: number;
  private readonly basisX = new THREE.Vector3();
  private readonly basisY = new THREE.Vector3();
  private readonly aligned = new THREE.Vector3();

  constructor(scene: THREE.Scene, quality: QualitySettings, sunDirection: THREE.Vector3) {
    this.mapSize = quality.shadowMapSize;
    this.ortho = quality.shadowOrtho;
    this.sunDirection = sunDirection.clone();

    // 环境补光（冷调天光 + 地面暖反照，平衡黄昏主光）
    scene.add(new THREE.HemisphereLight(0xa9c2dd, 0x4a3226, 0.5));

    const sun = new THREE.DirectionalLight(0xffd2a2, 3.3);
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
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    // 冷调补光：与主光反方位、抬高入射角，无阴影（环境反射与暗部细节来源）
    this.fill = new THREE.DirectionalLight(0x8fa9c9, 0.4);
    this.fill.castShadow = false;
    scene.add(this.fill);
    scene.add(this.fillTarget);
    this.fill.target = this.fillTarget;

    // P0-3 rim 轮廓光：冷白 0xcfe0ff，从车后侧低角入射（太阳反方位的侧面），
    // 掠过车身暗侧边缘形成一条冷光轮廓线（展厅感关键）。无阴影、强度 0.8 ——
    // 黑漆漫反射弱（roughness 0.42），0.6 实拍轮廓线不可读（t9 实证），提到 0.8。
    // 只勾轮廓不抢黄昏主光的暖调。
    this.rim = new THREE.DirectionalLight(0xcfe0ff, 0.8);
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
  }
}
