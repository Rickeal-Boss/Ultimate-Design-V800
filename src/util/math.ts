/** 常用数学工具 */
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 指时间阻尼（帧率无关的平滑），k 越大越快 */
export const damp = (current: number, target: number, k: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-k * dt));

/** 线性同余伪随机（可复现，与原版 Sg 一致的 9301/49297/233280 系数） */
export function makeLcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}
