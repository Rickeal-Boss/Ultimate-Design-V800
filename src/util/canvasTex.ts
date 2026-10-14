/** Canvas 2D 贴图生成工具（全部资产程序化生成，零外部图片） */
import * as THREE from 'three';

export function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [canvas, ctx];
}

/** 沥青噪点：随机灰点 */
export function paintNoise(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  count: number,
  alpha: number
): void {
  for (let i = 0; i < count; i++) {
    const g = Math.floor(Math.random() * 255);
    ctx.fillStyle = `rgba(${g},${g},${g},${alpha * Math.random()})`;
    const size = Math.random() * 2 + 0.5;
    ctx.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
}

export function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 发光文字贴图（车标/标牌通用） */
export function textTexture(
  lines: string[],
  bg: string,
  fg: string,
  width = 512,
  height = 256
): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(width, height);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, width - 28, height - 28);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.floor(height / (lines.length + 1.2))}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, (height / (lines.length + 1)) * (i + 1));
  });
  return canvasTexture(canvas);
}
