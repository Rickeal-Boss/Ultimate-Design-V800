/**
 * interiorTextures.ts —— R13 内饰贴图工厂（纯程序化 Canvas 2D，零外部图片、零 fetch）。
 *
 * 确定性：所有随机均来自固定种子 LCG（src/util/math.makeLcg），同引擎同种子输出逐像素可复现。
 * 颜色空间：本文件全部产物为颜色贴图，统一 THREE.SRGBColorSpace；anisotropy 刻意不在此设置，
 * 由集成层统一决定（历史教训：leather 各向异性 >22x 曾出「碎砖」摩尔纹——本批纹样均为
 * 近各向同性设计：菱格 / 圆点 / 短粒面刀纹，无长直条纹，远缩不产生方向性摩尔纹）。
 * 光栅 API 限定子集：fillRect / arc+fill / 折线 stroke / 线性与同心径向渐变，
 * 不用 save/restore/transform/setLineDash/fillText —— 便于无头探针以最小 shim 复现。
 *
 * ================= 导出接口一览（对应部件 / UV 约定详见各函数头注释）=================
 * 1. createSteeringWheelTexture()   方向盘轮缘环展贴图   → spec 组件 `steering`
 * 2. createSteeringHubTexture()     气囊盖正面贴图       → spec 组件 `steering-hub`
 * 3. createBrakePedalTexture()      刹车踏板单面贴图     → spec 组件 `brake-pedal`
 * 4. createSeatQuiltTexture(base)   座椅菱格绗缝平铺贴图 → `seat-*`（leather-warm/ivory 克隆）
 * 5. createWoodVeneerTexture()      中控木纹平铺贴图     → 中控/门板木饰（备用）
 */

import * as THREE from 'three';
import { makeCanvas } from '../util/canvasTex';
import { makeLcg } from '../util/math';

type RGB = readonly [number, number, number];
type Style = string | CanvasGradient;

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function css(c: RGB, a = 1): string {
  return a >= 1
    ? `rgb(${c[0]},${c[1]},${c[2]})`
    : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** 生成 CanvasTexture；tileable=true 用 RepeatWrapping（可平铺贴图），否则 ClampToEdge */
function toTexture(canvas: HTMLCanvasElement, tileable: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tileable ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = tileable ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** 皮革粒面：随机短刀纹（暗/亮交替，近各向同性——方向均匀分布，无拉伸条纹） */
function paintLeatherGrain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seed: number,
  count: number,
  base: RGB
): void {
  const rnd = makeLcg(seed);
  const dark = mix(base, BLACK, 0.55);
  const light = mix(base, WHITE, 0.32);
  for (let i = 0; i < count; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const ang = rnd() * Math.PI * 2;
    const len = 2 + rnd() * 4;
    const c = rnd() < 0.55 ? dark : light;
    ctx.strokeStyle = css(c, 0.05 + rnd() * 0.08);
    ctx.lineWidth = 0.8 + rnd();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
}

/**
 * 虚线线段（手工分段，不依赖 setLineDash）。phase 固定从 (x0,y0) 起——
 * 调用方以格点为端点即可保证平铺相位一致。
 */
function dashedSeg(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dashLen: number,
  gapLen: number,
  lineWidth: number,
  style: Style
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return;
  const ux = dx / len;
  const uy = dy / len;
  const period = dashLen + gapLen;
  for (let t = 0; t < len; t += period) {
    const b = Math.min(t + dashLen, len);
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x0 + ux * t, y0 + uy * t);
    ctx.lineTo(x0 + ux * b, y0 + uy * b);
    ctx.stroke();
  }
}

/** 平铺安全：对跨界线段按 ±(w,h) 平移补画（仅当平移后 bbox 与画布相交才绘制） */
function wrappedSeg(
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pad: number,
  draw: (ax0: number, ay0: number, ax1: number, ay1: number) => void
): void {
  const lx = Math.min(x0, x1) - pad;
  const rx = Math.max(x0, x1) + pad;
  const ty = Math.min(y0, y1) - pad;
  const by = Math.max(y0, y1) + pad;
  for (const ox of [-w, 0, w]) {
    if (rx + ox < 0 || lx + ox > w) continue;
    for (const oy of [-h, 0, h]) {
      if (by + oy < 0 || ty + oy > h) continue;
      draw(x0 + ox, y0 + oy, x1 + ox, y1 + oy);
    }
  }
}

/** 平铺安全圆点/圆面；makeStyle(dx,dy) 返回平移后的样式（径向渐变需随位移重建坐标） */
function wrappedDot(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  x: number,
  y: number,
  r: number,
  makeStyle: (dx: number, dy: number) => Style
): void {
  for (const ox of [-w, 0, w]) {
    if (x + ox + r < 0 || x + ox - r > w) continue;
    for (const oy of [-h, 0, h]) {
      if (y + oy + r < 0 || y + oy - r > h) continue;
      ctx.fillStyle = makeStyle(ox, oy);
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * 木饰段（方向盘环段用）：木纹沿环向（= 展开图的 x/u 方向）。
 * lx0/bwFull：本段在整段展开位形内的局部起点与整段宽度——12 点饰段跨 u 接缝，
 * 分两次绘制时传同一 seed 与 bwFull，局部纹样逐像素衔接，接缝无痕。
 */
function paintWoodBand(
  ctx: CanvasRenderingContext2D,
  xStart: number,
  xEnd: number,
  lx0: number,
  bwFull: number,
  h: number,
  seed: number,
  base: RGB,
  dark: RGB,
  light: RGB
): void {
  const bw = xEnd - xStart;
  if (bw <= 0) return;
  const rnd = makeLcg(seed);
  ctx.fillStyle = css(base);
  ctx.fillRect(xStart, 0, bw, h);
  // 宽色带：板面明暗起伏（低频）。按本段局部区间 [lx0, lx0+bw] 裁剪，
  // 防止跨接缝分段绘制时溢出到皮革区（同一 bwFull 坐标保证两段衔接）
  for (let i = 0; i < 6; i++) {
    const bxFull = lx0 + rnd() * bwFull;
    const bwd = 8 + rnd() * bwFull * 0.2;
    const segL = Math.max(lx0, bxFull);
    const segR = Math.min(lx0 + bw, bxFull + bwd);
    if (segR <= segL) continue;
    const c = rnd() < 0.5 ? dark : light;
    ctx.fillStyle = css(c, 0.06 + rnd() * 0.06);
    ctx.fillRect(xStart + (segL - lx0), 0, segR - segL, h);
  }
  // 环向细木纹：沿 x 的水平折线 + 周期波动（振幅小，近各向同性观感由皮革区承担）
  for (let i = 0; i < 30; i++) {
    const yb = rnd() * h;
    const amp = 1 + rnd() * 3.5;
    const k = 1 + Math.floor(rnd() * 3);
    const ph = rnd() * Math.PI * 2;
    const c = rnd() < 0.6 ? dark : light;
    ctx.strokeStyle = css(c, 0.18 + rnd() * 0.3);
    ctx.lineWidth = 0.7 + rnd() * 1.6;
    ctx.beginPath();
    const step = 6;
    for (let x = 0; x <= bw + step; x += step) {
      const cx = Math.min(x, bw);
      const lx = lx0 + cx;
      const y = yb + amp * Math.sin(2 * Math.PI * ((k * lx) / bwFull + ph));
      if (x === 0) ctx.moveTo(xStart + cx, y);
      else ctx.lineTo(xStart + cx, y);
    }
    ctx.stroke();
  }
}

/* ================================================================
 * 1. 方向盘轮缘
 * ================================================================ */

/**
 * createSteeringWheelTexture —— 方向盘轮缘环展贴图（对应 spec 组件 `steering`，
 * 工厂件 mesh_steering_77，torus/柱侧 UV：u = 绕轮缘一周，v = 轮缘断面方向）。
 *
 * 尺寸：1024×1024。UV 约定：x 轴 = u（0/1 接缝落在 12 点木饰段正中，天然无痕），
 * y 轴 = v（0 = 断面一侧边缘，1 = 另一侧；冠部高光绘于 v≈0.5）。
 * 内容：深咖双色真皮轮缘（粒面 + 冠部高光 + 米色缝线）+ 12/6 点红棕胡桃木饰段
 * （环向纹理，跨接缝分段绘制保证无缝）+ 饰段边界倒角线。
 * 各向异性评估：粒面为 2~6px 均匀方向短纹（近各向同性）；木纹限于两个 u 区段，
 * 长宽比 <3:1，远离射时 mip 均化，无「碎砖」风险。
 * 生成耗时量级：<30ms（1024² Canvas 2D）。
 */
export function createSteeringWheelTexture(): THREE.CanvasTexture {
  const S = 1024;
  const [canvas, ctx] = makeCanvas(S, S);
  const w = S;
  const h = S;

  // ---- 皮革底 + 冠部高光（v 向断面圆凸感）
  const leather = hexToRgb('#57402f');
  const leatherHi = mix(leather, hexToRgb('#8a6a4c'), 0.55);
  const leatherLo = mix(leather, hexToRgb('#1c120c'), 0.45);
  ctx.fillStyle = css(leather);
  ctx.fillRect(0, 0, w, h);
  const crown = ctx.createLinearGradient(0, 0, 0, h);
  crown.addColorStop(0, css(leatherLo, 0.85));
  crown.addColorStop(0.22, css(leather, 0));
  crown.addColorStop(0.5, css(leatherHi, 0.4));
  crown.addColorStop(0.78, css(leather, 0));
  crown.addColorStop(1, css(leatherLo, 0.85));
  ctx.fillStyle = crown;
  ctx.fillRect(0, 0, w, h);

  // ---- 皮革粒面（全域铺，木饰段随后覆盖）
  paintLeatherGrain(ctx, w, h, 1301, 5200, leather);

  // ---- 米色缝线：沿 u 走向双排虚线，只走皮革区（u∈[0.075,0.425]∪[0.575,0.925]）
  const stitch = hexToRgb('#e8d9c0');
  const leatherZones: Array<[number, number]> = [
    [0.075, 0.425],
    [0.575, 0.925],
  ];
  for (const vy of [0.13, 0.87]) {
    const y = vy * h;
    for (const [u0, u1] of leatherZones) {
      dashedSeg(ctx, u0 * w, y + 1.6, u1 * w, y + 1.6, 12, 7, 3.4, css(BLACK, 0.3));
      dashedSeg(ctx, u0 * w, y, u1 * w, y, 12, 7, 3, css(stitch, 0.9));
    }
  }

  // ---- 12/6 点红棕胡桃木饰段（半跨 ±0.075u ≈ ±27°）
  const woodBase = hexToRgb('#6b3f26');
  const woodDark = hexToRgb('#3f2214');
  const woodLight = hexToRgb('#8a5a38');
  const HALF = 0.075;
  const bwFull = 2 * HALF * w;
  // 12 点段（跨 u=0 接缝，两段同一 seed 保证衔接）
  paintWoodBand(ctx, (1 - HALF) * w, w, 0, bwFull, h, 1307, woodBase, woodDark, woodLight);
  paintWoodBand(ctx, 0, HALF * w, HALF * w, bwFull, h, 1307, woodBase, woodDark, woodLight);
  // 6 点段
  paintWoodBand(ctx, (0.5 - HALF) * w, (0.5 + HALF) * w, 0, bwFull, h, 1311, woodBase, woodDark, woodLight);

  // ---- 饰段边界倒角线（暗线 + 皮革侧微高光）
  for (const bx of [(1 - HALF) * w, HALF * w, (0.5 - HALF) * w, (0.5 + HALF) * w]) {
    ctx.strokeStyle = css(hexToRgb('#241207'), 0.6);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, 0);
    ctx.lineTo(bx, h);
    ctx.stroke();
    ctx.strokeStyle = css(mix(leather, WHITE, 0.3), 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx + (bx < 0.5 * w ? -3 : 3), 0);
    ctx.lineTo(bx + (bx < 0.5 * w ? -3 : 3), h);
    ctx.stroke();
  }

  return toTexture(canvas, true);
}

/* ================================================================
 * 2. 方向盘气囊盖
 * ================================================================ */

/**
 * createSteeringHubTexture —— 方向盘气囊盖正面贴图（对应 spec 组件 `steering-hub`，
 * 工厂件 mesh_steering_hub_78，lathe 圆盘，材质语义 leather-ivory + 中央银盾）。
 *
 * 尺寸：512×512。UV 约定：盘面正投影平面映射，圆盘内切于画布（圆心 256,256），
 * 画布四角为盘外（被几何裁掉）。内容：米白真皮盘面（粒面 + 中心微亮/边缘压暗）
 * + 外缘亮铬装饰环（对角线渐变模拟镜面反射）+ 双暗色分隔细环 + 中央银色徽标底座。
 * 各向异性评估：径向对称结构 + 均匀方向粒面，近各向同性。
 * 生成耗时量级：<10ms。
 */
export function createSteeringHubTexture(): THREE.CanvasTexture {
  const S = 512;
  const [canvas, ctx] = makeCanvas(S, S);
  const cx = S / 2;

  // ---- 米白真皮盘面
  const ivory = hexToRgb('#ddd3c2');
  ctx.fillStyle = css(ivory);
  ctx.fillRect(0, 0, S, S);
  paintLeatherGrain(ctx, S, S, 1323, 2600, ivory);
  const dome = ctx.createRadialGradient(cx, cx, 40, cx, cx, 250);
  dome.addColorStop(0, css(WHITE, 0.1));
  dome.addColorStop(0.7, css(BLACK, 0));
  dome.addColorStop(1, css(BLACK, 0.28));
  ctx.fillStyle = dome;
  ctx.fillRect(0, 0, S, S);

  // ---- 亮铬装饰环（对角渐变模拟环境反射）
  const chrome = ctx.createLinearGradient(cx - 230, cx - 230, cx + 230, cx + 230);
  chrome.addColorStop(0, '#f4f6f8');
  chrome.addColorStop(0.35, '#c3cad1');
  chrome.addColorStop(0.6, '#8d959d');
  chrome.addColorStop(0.85, '#d9dee3');
  chrome.addColorStop(1, '#aab1b8');
  ctx.strokeStyle = chrome;
  ctx.lineWidth = 30;
  ctx.beginPath();
  ctx.arc(cx, cx, 205, 0, Math.PI * 2);
  ctx.stroke();
  // 内外分隔细环
  const gap = css(hexToRgb('#2a211d'), 0.8);
  ctx.strokeStyle = gap;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cx, 188, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = gap;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cx, 222, 0, Math.PI * 2);
  ctx.stroke();

  // ---- 中央银色徽标底座（小铬盘，供上层盾标 mesh 叠加）
  const badge = ctx.createRadialGradient(cx - 12, cx - 12, 4, cx, cx, 54);
  badge.addColorStop(0, '#f2f4f6');
  badge.addColorStop(0.55, '#b8bfc6');
  badge.addColorStop(1, '#7d858d');
  ctx.fillStyle = badge;
  ctx.beginPath();
  ctx.arc(cx, cx, 54, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = css(hexToRgb('#3a3f45'), 0.7);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cx, 54, 0, Math.PI * 2);
  ctx.stroke();

  return toTexture(canvas, false);
}

/* ================================================================
 * 3. 刹车踏板
 * ================================================================ */

/**
 * createBrakePedalTexture —— 刹车踏板贴图（对应 spec 组件 `brake-pedal`，
 * V800Adapter.ts 内动态创建的 mesh，box 类几何的各面共用本图）。
 *
 * 尺寸：512×512。UV 约定：单面整图（ClampToEdge），y=0 为踏板上缘——
 * y∈[0, 0.38] 黑色橡胶防滑垫（错列圆点凸阵，径向渐变模拟凸起受光），
 * y∈[0.38, 1] 拉丝不锈钢（水平细拉丝 + 纵向高光带 + 左右暗角 + 分界槽）。
 * 若集成层希望橡胶垫出现在踏板下缘，设 texture.flipY 或调整 UV 即可。
 * 各向异性评估：拉丝为水平细纹（真实工艺方向），但对比度极低（α≤0.09）、
 * 长宽比 <4:1，配合低 anisotropy（≤4）远看不产生条纹摩尔纹；凸点阵各向同性。
 * 生成耗时量级：<15ms。
 */
export function createBrakePedalTexture(): THREE.CanvasTexture {
  const S = 512;
  const [canvas, ctx] = makeCanvas(S, S);
  const w = S;
  const h = S;
  const rubberH = Math.floor(h * 0.38);

  // ---- 拉丝不锈钢面：纵向高光渐变
  const steel = ctx.createLinearGradient(0, rubberH, 0, h);
  steel.addColorStop(0, '#9aa0a6');
  steel.addColorStop(0.25, '#c8cdd2');
  steel.addColorStop(0.55, '#b0b5ba');
  steel.addColorStop(0.85, '#83888e');
  steel.addColorStop(1, '#6f747a');
  ctx.fillStyle = steel;
  ctx.fillRect(0, rubberH, w, h - rubberH);

  // ---- 水平细拉丝（低对比，防摩尔纹）
  const rnd = makeLcg(1319);
  for (let i = 0; i < 700; i++) {
    const y = rubberH + rnd() * (h - rubberH);
    const x = rnd() * w;
    const len = 40 + rnd() * 120;
    const white = rnd() < 0.5;
    ctx.strokeStyle = white
      ? css(WHITE, 0.03 + rnd() * 0.06)
      : css(hexToRgb('#141619'), 0.03 + rnd() * 0.07);
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.stroke();
  }

  // ---- 左右暗角（体积感）
  const vignette = ctx.createLinearGradient(0, 0, w, 0);
  vignette.addColorStop(0, css(BLACK, 0.22));
  vignette.addColorStop(0.12, css(BLACK, 0));
  vignette.addColorStop(0.88, css(BLACK, 0));
  vignette.addColorStop(1, css(BLACK, 0.22));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, rubberH, w, h - rubberH);

  // ---- 钢/胶分界槽（暗槽 + 下沿反光）
  ctx.fillStyle = css(hexToRgb('#33363a'));
  ctx.fillRect(0, rubberH - 3, w, 3);
  ctx.fillStyle = css(WHITE, 0.4);
  ctx.fillRect(0, rubberH, w, 2);

  // ---- 黑色橡胶防滑垫 + 错列圆点凸阵
  ctx.fillStyle = css(hexToRgb('#1a1a1c'));
  ctx.fillRect(0, 0, w, rubberH - 3);
  const sp = 24;
  for (let row = 0, y = 14; y < rubberH - 16; y += sp * 0.87, row++) {
    for (let x = 14 + (row % 2) * (sp / 2); x < w - 8; x += sp) {
      const dot = ctx.createRadialGradient(x, y, 0, x, y, 6);
      dot.addColorStop(0, '#505054');
      dot.addColorStop(0.55, '#343438');
      dot.addColorStop(1, '#0c0c0e');
      ctx.fillStyle = dot;
      ctx.beginPath();
      ctx.arc(x, y, 5.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return toTexture(canvas, false);
}

/* ================================================================
 * 4. 座椅菱格绗缝
 * ================================================================ */

/**
 * createSeatQuiltTexture(baseColor) —— 座椅菱格绗缝可平铺贴图
 * （用于 seat-* 菱格面：leather-warm 克隆传 '#b08a5a' 系驼色，
 *  leather-ivory 克隆传 '#ddd3c2' 系米白；建议集成时材质 color 设白，避免与 map 相乘双重压暗）。
 *
 * 尺寸：512×512，四向无缝平铺（菱格节距 128px=半菱对角；集成层按 128px≈6~8cm 设 repeat）。
 * UV 约定：标准平面平铺，pattern 周期恰为整图（128×4）。
 * 结构：菱格（旋转 45° 正方格，半对角 64px）——格心径向渐变微凹 + 格脊双排缝线
 * （低对比亮色米缝线 + 下陷影线 + 脊侧微高光）+ 格脊交点小圆钎（亮珠）+ 细粒面。
 * 各向异性评估：菱格关于 x/y 对称（45° 正方格），缝线为 90.5px 短段（长宽比 ~9:1
 * 但对比度低、密度双向一致），粒面均匀方向——整体近各向同性，远缩无方向性摩尔纹。
 * 生成耗时量级：<25ms。
 */
export function createSeatQuiltTexture(baseColor = '#b08a5a'): THREE.CanvasTexture {
  const S = 512;
  const [canvas, ctx] = makeCanvas(S, S);
  const base = hexToRgb(baseColor);
  const cell = 128; // 菱格节距（x 向同列间距）
  const half = 64; // 半对角

  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, S, S);
  paintLeatherGrain(ctx, S, S, 1321, 1600, base);

  const recess = mix(base, BLACK, 0.28);
  const stitchC = mix(base, hexToRgb('#e8d9c0'), 0.4);
  const shadow = mix(base, BLACK, 0.4);
  const ridgeHi = mix(base, WHITE, 0.35);
  const bead = mix(base, WHITE, 0.55);

  // ---- 格心微凹（径向渐变，平铺补画）
  for (let j = -1; j <= 8; j++) {
    for (let i = -1; i <= 4; i++) {
      const x = i * cell + (Math.abs(j % 2) === 1 ? half : 0);
      const y = j * half;
      wrappedDot(ctx, S, S, x, y, 58, (dx, dy) => {
        const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, 58);
        g.addColorStop(0, css(recess, 0.5));
        g.addColorStop(0.65, css(recess, 0.2));
        g.addColorStop(1, css(recess, 0));
        return g;
      });
    }
  }

  // ---- 格脊：每格心引 2 条棱（右 vertex → 上/下 vertex），恰覆盖全部棱一次
  // 影线（下陷）→ 主缝线（米色虚线）→ 脊侧微高光，均平铺补画
  for (let j = -1; j <= 8; j++) {
    for (let i = -1; i <= 4; i++) {
      const cx = i * cell + (Math.abs(j % 2) === 1 ? half : 0);
      const cy = j * half;
      const oySign = 1;
      for (const ey of [half, -half]) {
        const x0 = cx + half;
        const y0 = cy;
        const x1 = cx;
        const y1 = cy + ey;
        wrappedSeg(S, S, x0, y0, x1, y1, 4, (ax0, ay0, ax1, ay1) => {
          // 影线
          dashedSeg(ctx, ax0, ay0 + 1.6 * oySign, ax1, ay1 + 1.6 * oySign, 9, 6, 3.2, css(shadow, 0.4));
          // 主缝线
          dashedSeg(ctx, ax0, ay0, ax1, ay1, 9, 6, 2.8, css(stitchC, 0.85));
          // 脊侧微高光（垂直棱方向外偏 1.6px，凸缝受光）
          ctx.strokeStyle = css(ridgeHi, 0.16);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(ax0 + 1.6, ay0 + 1.6 * (ey > 0 ? 1 : -1));
          ctx.lineTo(ax1 + 1.6, ay1 + 1.6 * (ey > 0 ? 1 : -1));
          ctx.stroke();
        });
      }
    }
  }

  // ---- 小圆钎（格脊交点，即 (a·64, b·64) 且 a+b 为奇的格点）：暗托 + 亮珠
  for (let b = -1; b <= 8; b++) {
    for (let a = -1; a <= 8; a++) {
      if ((a + b) % 2 === 0) continue;
      const x = a * half;
      const y = b * half;
      wrappedDot(ctx, S, S, x, y, 3.4, () => css(BLACK, 0.3));
      wrappedDot(ctx, S, S, x, y, 2.2, () => css(bead, 0.8));
    }
  }

  return toTexture(canvas, true);
}

/* ================================================================
 * 5. 中控木纹饰板
 * ================================================================ */

/**
 * createWoodVeneerTexture —— 中控/门板木纹饰板贴图（备用，红棕直纹胡桃 + 哑光清漆感）。
 *
 * 尺寸：512×512，四向无缝平铺（竖纹：y 向波纹为整数周期正弦，x/y 接缝由补画保证）。
 * UV 约定：标准平面平铺，纹理竖向为主（repeat 旋转可改横向）。
 * 内容：红棕胡桃底 + 纵向宽色带（板面明暗）+ 竖向细木纹（微波动）+ 细短孔纹
 * + 低对比横向哑光清漆光带。
 * 各向异性评估：木纹为竖向长纹（真实直纹木方向性），但对比度中低且宽窄/间距随机化，
 * 远缩时呈均匀「木色」而不产生高频摩尔纹；如需苛刻场景可把 repeat 设非整数打破周期。
 * 生成耗时量级：<15ms。
 */
export function createWoodVeneerTexture(): THREE.CanvasTexture {
  const S = 512;
  const [canvas, ctx] = makeCanvas(S, S);
  const base = hexToRgb('#6b3f26');
  const dark = hexToRgb('#3f2214');
  const light = hexToRgb('#8a5a38');

  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, S, S);

  const rnd = makeLcg(1327);

  // ---- 纵向宽色带（x 向平铺补画）
  for (let i = 0; i < 10; i++) {
    const bx = rnd() * S;
    const bw = 20 + rnd() * 70;
    const c = rnd() < 0.5 ? dark : light;
    for (const ox of [-S, 0, S]) {
      if (bx + ox + bw < 0 || bx + ox > S) continue;
      ctx.fillStyle = css(c, 0.05 + rnd() * 0.05);
      ctx.fillRect(bx + ox, 0, bw, S);
    }
  }

  // ---- 竖向细木纹（逐段补画，x/y 双向无缝）
  for (let i = 0; i < 46; i++) {
    const xi = rnd() * S;
    const amp = 1.5 + rnd() * 4;
    const k = 1 + Math.floor(rnd() * 4);
    const ph = rnd() * Math.PI * 2;
    const isDark = rnd() < 0.7;
    const c = isDark ? mix(base, dark, 0.4 + rnd() * 0.5) : mix(base, light, 0.4 + rnd() * 0.4);
    ctx.strokeStyle = css(c, 0.25 + rnd() * 0.35);
    ctx.lineWidth = 0.7 + rnd() * 1.5;
    let px = xi;
    for (let y = 8; y <= S + 8; y += 8) {
      const x = xi + amp * Math.sin(2 * Math.PI * ((k * y) / S + ph));
      const prevX = px;
      px = x;
      if (y === 8) continue;
      wrappedSeg(S, S, prevX, y - 8, x, y, 2, (ax0, ay0, ax1, ay1) => {
        ctx.beginPath();
        ctx.moveTo(ax0, ay0);
        ctx.lineTo(ax1, ay1);
        ctx.stroke();
      });
    }
  }

  // ---- 细短孔纹（近各向同性的短竖点刻）
  for (let i = 0; i < 700; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const len = 2 + rnd() * 2.5;
    ctx.strokeStyle = css(dark, 0.04 + rnd() * 0.05);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5), y + len);
    ctx.stroke();
  }

  // ---- 哑光清漆横向光带（低对比，纵向渐变软过渡避免硬边，y 向平铺补画）
  for (let i = 0; i < 3; i++) {
    const by = rnd() * S;
    const bh = 60 + rnd() * 120;
    for (const oy of [-S, 0, S]) {
      if (by + oy + bh < 0 || by + oy > S) continue;
      const sheen = ctx.createLinearGradient(0, by + oy, 0, by + oy + bh);
      sheen.addColorStop(0, css(WHITE, 0));
      sheen.addColorStop(0.5, css(WHITE, 0.035));
      sheen.addColorStop(1, css(WHITE, 0));
      ctx.fillStyle = sheen;
      ctx.fillRect(0, by + oy, S, bh);
    }
  }

  return toTexture(canvas, true);
}
