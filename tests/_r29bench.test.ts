/** 临时基准：程序化石材生成耗时 + 输出统计（跑完即删，不进交付） */
import { describe, it } from 'vitest';
import { makeStonePixelSet } from '../src/render/scene/stoneTexture';
import type { StoneKind } from '../src/render/scene/stoneTexture';

const KINDS: StoneKind[] = ['ashlar', 'wall', 'floor', 'gold', 'rock', 'roof', 'wood', 'glass', 'marble'];

/** 与 tools/r29_tex_stats.py 同口径：L = 0.2126R + 0.7152G + 0.0722B */
function lumStats(a: Uint8ClampedArray): { p05: number; p50: number; p95: number; mean: number; std: number } {
  const n = a.length / 4;
  const l = new Float64Array(n);
  for (let i = 0; i < n; i += 1) l[i] = 0.2126 * a[i * 4] + 0.7152 * a[i * 4 + 1] + 0.0722 * a[i * 4 + 2];
  const s = Array.from(l).sort((x, y) => x - y);
  const mean = s.reduce((p, c) => p + c, 0) / n;
  let v = 0;
  for (let i = 0; i < n; i += 1) v += (s[i] - mean) ** 2;
  return { p05: s[(n * 0.05) | 0], p50: s[(n * 0.5) | 0], p95: s[(n * 0.95) | 0], mean, std: Math.sqrt(v / n) };
}

/** 颗粒能量：3x3 高通残差 std（越高=细节越细） */
function grainEnergy(a: Uint8ClampedArray, size: number): number {
  const n = size * size;
  const l = new Float64Array(n);
  for (let i = 0; i < n; i += 1) l[i] = 0.2126 * a[i * 4] + 0.7152 * a[i * 4 + 1] + 0.0722 * a[i * 4 + 2];
  let v = 0;
  let c = 0;
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x;
      const hp = l[i] - (l[i - 1] + l[i + 1] + l[i - size] + l[i + size]) * 0.25;
      v += hp * hp;
      c += 1;
    }
  }
  return Math.sqrt(v / c);
}

/** 法线强度：|n.xy| 均值 */
function normalMag(a: Uint8ClampedArray): number {
  const n = a.length / 4;
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const nx = (a[i * 4] / 255) * 2 - 1;
    const ny = (a[i * 4 + 1] / 255) * 2 - 1;
    s += Math.hypot(nx, ny);
  }
  return s / n;
}

function roughMean(a: Uint8ClampedArray): number {
  const n = a.length / 4;
  let s = 0;
  for (let i = 0; i < n; i += 1) s += a[i * 4];
  return s / n / 255;
}

describe('bench', () => {
  it('gen cost + output stats', () => {
    for (const size of [512]) {
      for (const k of KINDS) {
        try {
          makeStonePixelSet(k, { size });
          const t = performance.now();
          const r = makeStonePixelSet(k, { size });
          const ms = performance.now() - t;
          const st = lumStats(r.albedo);
          console.log(
            `${k.padEnd(7)} ${size} ${ms.toFixed(1).padStart(6)}ms | L ${st.mean.toFixed(1)}±${st.std.toFixed(1)} ` +
              `p05 ${st.p05.toFixed(0)} p50 ${st.p50.toFixed(0)} p95 ${st.p95.toFixed(0)} C ${(st.p95 - st.p05).toFixed(0)} | ` +
              `grain ${grainEnergy(r.albedo, size).toFixed(2)} | n|xy| ${normalMag(r.normal).toFixed(4)} | roughMean ${roughMean(r.rough).toFixed(3)}`
          );
        } catch (e) {
          console.log(`${k} ${size}  ERR ${String(e).slice(0, 70)}`);
        }
      }
    }
  });
});
