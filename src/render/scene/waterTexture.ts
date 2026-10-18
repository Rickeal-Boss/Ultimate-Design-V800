/**
 * 程序化水面贴图（零外部图片，固定种子可复现）。
 * 颜色图：深青暮色底 + 横向流纹 + 暖色霞光碎斑（黄昏反射感）；
 * 法线图：Canvas 直绘伪法线（基色 128,128,255 + 水平偏置椭圆笔触），驱动envMap 碎波闪烁。
 * 注意：法线图必须保持线性色彩空间（不得像 canvasTexture 那样设 SRGB）。
 */
import * as THREE from 'three';
import { makeCanvas } from '../../util/canvasTex';
import { makeLcg } from '../../util/math';

/** 水面颜色贴图：256×256，LCG 固定种子（确定性，禁止 Math.random） */
export function createWaterColorTexture(): THREE.CanvasTexture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);
  const random = makeLcg(731629);

  // 底色：纵向渐变，深青 #1c3438 → 略亮的暮色青 #22424a
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#1c3438');
  grad.addColorStop(1, '#22424a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // 横向流纹：水平长椭圆笔触，亮度微抬（模拟缓流拉丝）
  for (let i = 0; i < 220; i++) {
    const y = random() * size;
    const x = random() * size;
    const len = 18 + random() * 70;
    const a = 0.05 + random() * 0.1;
    ctx.fillStyle = `rgba(72,118,120,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, len / 2, 1 + random() * 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 霞光碎斑：暖橙低透明度，稀疏点缀（黄昏天空在水面上的反射碎块）
  for (let i = 0; i < 70; i++) {
    const y = random() * size;
    const x = random() * size;
    const w = 3 + random() * 16;
    const a = 0.04 + random() * 0.09;
    ctx.fillStyle = `rgba(214,138,92,${a.toFixed(3)})`;
    ctx.fillRect(x, y, w, 1 + random() * 1.6);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 水面法线贴图：256×256 伪法线直绘，线性空间，固定种子 */
export function createWaterNormalTexture(): THREE.CanvasTexture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);
  const random = makeLcg(519427);

  ctx.fillStyle = 'rgb(128,128,255)'; // 平坦法线
  ctx.fillRect(0, 0, size, size);

  // 水平偏置波纹笔触：R/G 通道小扰动 → 缓波起伏，横向拉长（与流纹方向一致）
  for (let i = 0; i < 380; i++) {
    const dx = Math.round((random() - 0.5) * 76);
    const dy = Math.round((random() - 0.5) * 30);
    ctx.fillStyle = `rgb(${128 + dx},${128 + dy},255)`;
    ctx.beginPath();
    ctx.ellipse(
      random() * size,
      random() * size,
      6 + random() * 26,
      1.5 + random() * 3.5,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  // 法线图保持线性（默认 NoColorSpace），切勿设 SRGB
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
