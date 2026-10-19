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

/**
 * 河面「纵深」贴图（R14，非重复、1:1 铺在 280×140 的水面上）：
 * - 纵向（v，跨河方向）渐变：两岸浅 #3a6360 → 河心深 #0f272d，读作真实水深变化；
 * - 顺流长条流纹（沿 u，河道横向）；
 * - 黄昏暖色碎斑（天空反射）；
 * - v≈0.078 / 0.921 两条白噪泡沫带 —— 正是护坡与水面相交的水线位置
 *   （水面平面外扩 20m 压在护坡下，可见水线的 v 由 20/(120+20)=… 反推为 0.079）。
 * 必须 ClampToEdge：Repeat 会把「岸边浅色」卷到河心。
 */
export function createWaterBasinTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const [canvas, ctx] = makeCanvas(w, h);
  const random = makeLcg(246813);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  // R17：提亮加饱和（暗青 #173a42/#4a7d78 在黄昏暖光下被洗成沙色——消去法实证
  // verify/r17/water/w_00 红探针：能存活的是高饱和色）。青绿亮度抬一档、饱和度加倍，
  // 暖光 × 青绿 = 仍读得出「水」。
  grad.addColorStop(0, '#5FB8AE');
  grad.addColorStop(0.18, '#3A8F94');
  grad.addColorStop(0.5, '#1E7585');
  grad.addColorStop(0.82, '#3A8F94');
  grad.addColorStop(1, '#5FB8AE');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // 顺流流纹：横向长椭圆，亮度微抬
  for (let i = 0; i < 260; i++) {
    const y = random() * h;
    const x = random() * w;
    const len = 40 + random() * 180;
    const a = 0.04 + random() * 0.09;
    ctx.fillStyle = `rgba(150,215,212,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, len / 2, 0.8 + random() * 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 霞光碎斑
  for (let i = 0; i < 90; i++) {
    const y = random() * h;
    const x = random() * w;
    const len = 8 + random() * 34;
    const a = 0.04 + random() * 0.08;
    ctx.fillStyle = `rgba(216,150,104,${a.toFixed(3)})`;
    ctx.fillRect(x, y, len, 0.8 + random() * 1.4);
  }

  // 岸边泡沫带：贴图 v 方向 140m/256px ≈ 0.55m/px，带宽 ±5px ≈ 2.7m
  // （R14 首版 ±11px=12m 宽的泡沫在水面上读成一道白墙，俯视尤其假）
  const foam = (v: number): void => {
    const y = v * h;
    const g = ctx.createLinearGradient(0, y - 6, 0, y + 6);
    g.addColorStop(0, 'rgba(226,240,238,0)');
    g.addColorStop(0.5, 'rgba(226,240,238,0.22)');
    g.addColorStop(1, 'rgba(226,240,238,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 6, w, 12);
    for (let i = 0; i < 240; i++) {
      const x = random() * w;
      const yy = y + (random() - 0.5) * 9;
      ctx.fillStyle = `rgba(238,248,246,${(0.08 + random() * 0.26).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x, yy, 1.5 + random() * 6, 0.5 + random() * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  foam(0.079);
  foam(0.921);
  // 河道东西两端的水线（x=±126 → u≈0.05/0.95）：低角度侧看时对岸的水线全靠这条泡沫读出来
  const foamU = (u: number): void => {
    const x = u * w;
    for (let i = 0; i < 200; i++) {
      const y = random() * h;
      ctx.fillStyle = `rgba(238,248,246,${(0.06 + random() * 0.22).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x + (random() - 0.5) * 10, y, 1.2 + random() * 4.5, 0.5 + random() * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  foamU(0.049);
  foamU(0.951);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** 水面法线贴图：256×256 伪法线直绘，线性空间，固定种子 */
export function createWaterNormalTexture(): THREE.CanvasTexture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);
  const random = makeLcg(519427);

  ctx.fillStyle = 'rgb(128,128,255)'; // 平坦法线
  ctx.fillRect(0, 0, size, size);

  // 水平偏置波纹笔触：R/G 通道小扰动 → 缓波起伏，横向拉长（与流纹方向一致）。
  // 三层递减 alpha 叠画 = 软边（R14 首版硬边椭圆在低角度下读成一片片油污斑）
  for (let i = 0; i < 380; i++) {
    const dx = Math.round((random() - 0.5) * 56);
    const dy = Math.round((random() - 0.5) * 22);
    const cx = random() * size;
    const cy = random() * size;
    const rx = 6 + random() * 26;
    const ry = 1.5 + random() * 3.5;
    for (const [scale, alpha] of [
      [1.9, 0.1],
      [1.35, 0.22],
      [1, 0.42]
    ] as const) {
      ctx.fillStyle = `rgba(${128 + dx},${128 + dy},255,${alpha})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * scale, ry * scale, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  // 法线图保持线性（默认 NoColorSpace），切勿设 SRGB
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
