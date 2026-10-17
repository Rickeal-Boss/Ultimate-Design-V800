/**
 * P0-2 车下软接触阴影（自包含类，零外部资产）。
 *
 * 对标报告 ② 号差距：只有方向光硬阴影，车底缺大而软的环境遮蔽暗盘，车「浮」。
 * 做法：canvas 径向渐变贴图（中心黑 α~0.55 → 边缘透明）贴水平面片，
 * 无光照 MeshBasicMaterial + transparent + depthWrite:false —— 纯贴花，
 * 不受光照影响、不参与深度写入（贴在路面上不 z-fight），渲染序高于路面。
 *
 * 接口自包含（正式集成由 Game 层接线）：
 *   const shadow = new ContactShadow(scene);
 *   // 每帧（或渲染前）：
 *   shadow.update(car.body);
 *
 * ⚠️ 车身坐标口径：adapter body 自带 rotY(π)，本类只取 carBody 的**世界 xz**
 * 对位（不读局部朝向），平面自身无旋转需求（径向渐变各向同性）；
 * y 恒贴地（构造时给定，默认 0.02，略高于路面防 z-fight）。
 */
import * as THREE from 'three';

export interface ContactShadowOptions {
  /** 面片宽度（x，垂直车身纵向） */
  width?: number;
  /** 面片深度（z，车身纵向） */
  depth?: number;
  /** 中心不透明度（0..1，rgba(0,0,0,α) 的 α） */
  opacity?: number;
  /** 贴地高度（略高于路面） */
  y?: number;
  /** 渐变贴图边长（px） */
  textureSize?: number;
}

function createContactShadowTexture(size: number, opacity: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // 径向渐变：中心 0.55 α 黑 → 35% 处快速衰减 → 边缘全透明（无硬边）
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(0, 0, 0, ${opacity})`);
  grad.addColorStop(0.35, `rgba(0, 0, 0, ${opacity * 0.72})`);
  grad.addColorStop(0.7, `rgba(0, 0, 0, ${opacity * 0.24})`);
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class ContactShadow {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly texture: THREE.CanvasTexture;

  constructor(scene: THREE.Scene, options: ContactShadowOptions = {}) {
    const {
      // R12b 修正长宽转置（外部审查 P1）：PlaneGeometry(width→x, depth→z)。
      // 原 5.6×2.6 让阴影左右各溢 1.8m、车头车尾各缺 1.3m。
      width = 2.4, // x：车宽 2.03 + 余量
      depth = 5.75, // z：车长 5.61 + 余量
      opacity = 0.55,
      y = 0.02,
      textureSize = 256
    } = options;
    this.texture = createContactShadowTexture(textureSize, opacity);
    const geo = new THREE.PlaneGeometry(width, depth);
    geo.rotateX(-Math.PI / 2); // 水平放倒，法线 +y
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      opacity: 1
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'contact-shadow';
    this.mesh.renderOrder = 2; // 高于路面（默认 0），透明贴花最后画
    this.mesh.position.y = y;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = true;
    scene.add(this.mesh);
  }

  /**
   * 每帧对位：取 carBody 世界位置 xz（body 有 rotY(π)，只取平移不取朝向），
   * 平面跟随；y 恒贴地（车跳起/坠落时接触阴影留在地面，符合软阴影语义）。
   */
  update(carBody: THREE.Object3D): void {
    const p = carBody.getWorldPosition(ContactShadow.tmpVec);
    this.mesh.position.set(p.x, this.mesh.position.y, p.z);
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }

  private static readonly tmpVec = new THREE.Vector3();
}
