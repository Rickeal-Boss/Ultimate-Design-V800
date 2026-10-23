/**
 * R29 · T2 天空烘焙「视觉不退化」量化验证（纯 node，不需要浏览器）。
 *
 * 把 src/render/scene/Environment.ts 的 SKY_FRAG **逐行复刻**成 JS，然后：
 *   ① 参考图 = 每个相机光线直接算 skyColor（= 现在的每帧 fbm 做法）
 *   ② 对比图 = 先把 skyColor 烘到 W×H equirect，再按 equirectUv 双线性采样
 * 两者都过同一条 ACESFilmic(exposure 0.85) + sRGB 编码管线，最后按**区域**统计
 * 中位亮度 L 与方差，给出 ΔL / Δ方差，作为「肉眼无退化」的客观口径。
 *
 * 运行：
 *   npx vite-node tools/r29_sky_bake_diff.ts
 */
import { Color } from 'three';
import { ACTIVE_ENV } from '../src/config/environment';

// ── 线性工作色（与 shader uniform 同口径：THREE.Color(hex) → linear-sRGB）──
const lin = (hex: number): [number, number, number] => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};

const P = {
  zenith: lin(ACTIVE_ENV.sky.zenith),
  mid: lin(ACTIVE_ENV.sky.mid),
  horizon: lin(ACTIVE_ENV.sky.horizon),
  ground: lin(ACTIVE_ENV.sky.ground),
  sunColor: lin(ACTIVE_ENV.sky.sunColor),
  cloudAmount: ACTIVE_ENV.sky.cloudAmount
};
const mid = new Color(ACTIVE_ENV.sky.mid);
const cloudLit = mid
  .clone()
  .lerp(new Color(ACTIVE_ENV.sky.horizon), 0.3)
  .multiplyScalar(0.26);
const cloudDark = mid
  .clone()
  .lerp(new Color(ACTIVE_ENV.sky.ground), 0.55)
  .multiplyScalar(0.2);
const CLOUD_LIT: [number, number, number] = [cloudLit.r, cloudLit.g, cloudLit.b];
const CLOUD_DARK: [number, number, number] = [cloudDark.r, cloudDark.g, cloudDark.b];

// 太阳方向（与 Environment.directionFromSun 同式）
const el = (ACTIVE_ENV.sun.elevationDeg * Math.PI) / 180;
const az = (ACTIVE_ENV.sun.azimuthDeg * Math.PI) / 180;
const SUN: [number, number, number] = [
  Math.sin(Math.PI / 2 - el) * Math.sin(az),
  Math.cos(Math.PI / 2 - el),
  Math.sin(Math.PI / 2 - el) * Math.cos(az)
];

// ── GLSL 原语 ─────────────────────────────────────────────────────────
const fract = (x: number) => x - Math.floor(x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: number[], b: number[], t: number) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return mix(
    mix(hash(ix, iy), hash(ix + 1, iy), ux),
    mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), ux),
    uy
  );
}
function fbm(x: number, y: number): number {
  let v = 0;
  let a = 0.5;
  for (let i = 0; i < 5; i += 1) {
    v += a * noise2(x, y);
    x *= 2.03;
    y *= 2.03;
    a *= 0.5;
  }
  return v;
}

/** SKY_FRAG 的 skyColor(dir)，返回**线性** RGB（tonemap 之前） */
function skyColor(dir: number[]): [number, number, number] {
  const n = Math.hypot(dir[0], dir[1], dir[2]);
  const d: [number, number, number] = [dir[0] / n, dir[1] / n, dir[2] / n];
  const h = d[1];
  const sd = Math.max(0, d[0] * SUN[0] + d[1] * SUN[1] + d[2] * SUN[2]);

  // 地平线基色按太阳方位分裂
  let col = mix3(P.mid, P.horizon, smoothstep(0.3, 0.92, sd)) as [number, number, number];
  if (h > 0) {
    const t1 = smoothstep(0.0, 0.18, h);
    const t2 = smoothstep(0.12, 0.65, h);
    col = mix3(col, P.mid, t1) as [number, number, number];
    col = mix3(col, P.zenith, t2) as [number, number, number];
  } else {
    col = mix3(col, P.ground, smoothstep(0.0, 0.08, -h)) as [number, number, number];
  }
  // 逆光暖晕（贴地平线横向亮带）
  let glow = Math.pow(sd, 4) * 0.13 + Math.pow(sd, 16) * 0.13;
  const bandWeight = 1 - smoothstep(0.0, 0.12, Math.abs(h));
  glow *= mix(0.16, 1.0, bandWeight);
  const gate = smoothstep(-0.1, 0.02, h);
  col = [col[0] + P.sunColor[0] * glow * gate, col[1] + P.sunColor[1] * glow * gate, col[2] + P.sunColor[2] * glow * gate];
  // 辉光柱
  const glowCol = Math.pow(sd, 3) * Math.exp(-Math.pow((h - 0.32) / 0.34, 2)) * 0.14;
  const gate2 = smoothstep(-0.12, 0.1, h);
  col = [
    col[0] + P.sunColor[0] * glowCol * gate2,
    col[1] + P.sunColor[1] * glowCol * gate2,
    col[2] + P.sunColor[2] * glowCol * gate2
  ];
  // 日盘（两级幂次）
  const disk = Math.pow(sd, 90) * 0.3 + Math.pow(sd, 900) * 0.55;
  col = [col[0] + P.sunColor[0] * disk, col[1] + P.sunColor[1] * disk, col[2] + P.sunColor[2] * disk];

  if (h > 0) {
    const ux = (d[0] / (h + 0.12)) * 0.6;
    const uz = (d[2] / (h + 0.12)) * 1.6;
    const base = fbm(ux * 1.3 + 3.1, uz * 1.3 + 0.7);
    const detail = fbm(ux * 3.4 - 1.7, uz * 3.4 + 2.3);
    const macro = fbm(ux * 0.5 + 8.2, uz * 0.5 - 4.1);
    const cover = smoothstep(0.44, 0.8, base) * (0.72 + (detail - 0.5) * 0.55) * (0.72 + macro * 0.56);
    const vertical = smoothstep(0.015, 0.15, h) * (1 - smoothstep(0.28, 0.9, h));
    const c = Math.min(0.94, Math.max(0, cover * P.cloudAmount * vertical));
    const cloudBand = 1 - smoothstep(0.06, 0.3, Math.abs(h));
    const nearSun = mix3(CLOUD_LIT, P.sunColor.map((x) => x * 1.12), (Math.pow(sd, 2) * 0.85 + 0.15) * cloudBand);
    const cloud = mix3(nearSun, CLOUD_DARK, smoothstep(0.34, 0.86, detail));
    col = mix3(col, cloud as number[], c) as [number, number, number];
  }
  return col;
}

// ── three 的 ACESFilmic + sRGB（与 r26_sky_predict.mjs 同式）────────────
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
void srgbToLinear;
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const EXPOSURE = 0.85;
const rrtAndOdtFit = (v: number[]) =>
  v.map((x) => {
    const a = x * (x + 0.0245786) - 0.000090537;
    const b = x * (0.983729 * x + 0.432951) + 0.238081;
    return a / b;
  });
const ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777]
];
const ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602]
];
const mul = (m: number[][], v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
function toneMap(linear: number[]): [number, number, number] {
  const scaled = linear.map((c) => (c * EXPOSURE) / 0.6);
  const aced = rrtAndOdtFit(mul(ACES_IN, scaled));
  const out = mul(ACES_OUT, aced).map((c) => Math.min(1, Math.max(0, c)));
  return out.map((c) => linearToSrgb(c) * 255) as [number, number, number];
}
const lum = (rgb: number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

// ── equirect 互转（与 shader 同式）─────────────────────────────────────
function equirectUv(d: number[]): [number, number] {
  const u = Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5;
  const v = Math.asin(clamp01(Math.abs(d[1])) * Math.sign(d[1] || 1)) / Math.PI + 0.5;
  return [u, v];
}
function uvToDir(u: number, v: number): number[] {
  const phi = (v - 0.5) * Math.PI;
  const theta = (u - 0.5) * 2 * Math.PI;
  const cr = Math.cos(phi);
  return [cr * Math.cos(theta), Math.sin(phi), cr * Math.sin(theta)];
}

/** 烘焙一张 W×H equirect（线性） */
function bake(W: number, H: number): Float32Array {
  const buf = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x += 1) {
      const u = (x + 0.5) / W;
      const c = skyColor(uvToDir(u, v));
      const i = (y * W + x) * 3;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
    }
  }
  return buf;
}

/** 双线性采样（S 方向 repeat，T 方向 clamp）—— 与 GPU LinearFilter 同口径 */
function sample(buf: Float32Array, W: number, H: number, u: number, v: number): [number, number, number] {
  const fx = u * W - 0.5;
  const fy = v * H - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const wrapX = (i: number) => ((i % W) + W) % W;
  const clampY = (i: number) => Math.min(H - 1, Math.max(0, i));
  const px = (xi: number, yi: number) => {
    const i = (clampY(yi) * W + wrapX(xi)) * 3;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };
  const a = px(x0, y0);
  const b = px(x0 + 1, y0);
  const c = px(x0, y0 + 1);
  const d = px(x0 + 1, y0 + 1);
  const lo0 = mix3(a, b, tx);
  const lo1 = mix3(c, d, tx);
  return mix3(lo0, lo1, ty) as [number, number, number];
}

// ── 相机光线集 ─────────────────────────────────────────────────────────
interface View {
  name: string;
  yawDeg: number;
  pitchDeg: number;
}
const VIEWS: View[] = [
  { name: '朝城堡 −Z / 俯 5°', yawDeg: 180, pitchDeg: -5 },
  { name: '朝城堡 −Z / 仰 18°', yawDeg: 180, pitchDeg: 18 },
  { name: '正对太阳 195° / 仰 12°', yawDeg: 195, pitchDeg: 12 },
  { name: '侧机位 90° / 仰 5°', yawDeg: 90, pitchDeg: 5 }
];
// 采样分辨率对齐 1080p 的量级（1080p 的 1/4 线性密度 → 逐像素 ΔL 才不会被网格掩盖）
const RW = 960;
const RH = 540;
const VFOV = 55;

function rays(view: View): number[][] {
  const out: number[][] = [];
  const yaw = (view.yawDeg * Math.PI) / 180;
  const pitch = (view.pitchDeg * Math.PI) / 180;
  // 前向量
  const fwd = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch)
  ];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0]
  ];
  const tanHalf = Math.tan((VFOV * Math.PI) / 180 / 2);
  const aspect = RW / RH;
  for (let y = 0; y < RH; y += 1) {
    const sy = (1 - (2 * (y + 0.5)) / RH) * tanHalf;
    for (let x = 0; x < RW; x += 1) {
      const sx = ((2 * (x + 0.5)) / RW - 1) * tanHalf * aspect;
      // 必须归一化：shader 里 vDir = normalize(...)，equirectUv 的 asin(y) 只有在
      // 单位向量上才成立（未归一化时 y 被放大 → v 偏 → 对比出假的巨大 ΔL）
      const rx = fwd[0] + right[0] * sx + up[0] * sy;
      const ry = fwd[1] + right[1] * sx + up[1] * sy;
      const rz = fwd[2] + right[2] * sx + up[2] * sy;
      const rn = Math.hypot(rx, ry, rz);
      out.push([rx / rn, ry / rn, rz / rn]);
    }
  }
  return out;
}

function median(a: number[]): number {
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
}
function variance(a: number[]): number {
  const m = a.reduce((p, q) => p + q, 0) / a.length;
  return a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length;
}

/** 参考图（每帧 fbm 做法）缓存：只算一次，供所有分辨率复用 */
const REF_CACHE = new Map<string, number[]>();

function main(): void {
  const sizes: Array<[number, number]> = [
    [512, 256],
    [1024, 512],
    [2048, 1024]
  ];
  for (const [W, H] of sizes) {
    const t0 = Date.now();
    const buf = bake(W, H);
    const bakeMs = Date.now() - t0;
    console.log(
      `\n════ equirect ${W}×${H} （CPU 烘焙 ${bakeMs}ms；GPU 上约为其 1/100） ════`
    );
    for (const view of VIEWS) {
      const rs = rays(view);
      const got: number[] = [];
      let ref = REF_CACHE.get(view.name);
      if (!ref) {
        ref = rs.map((r) => lum(toneMap(skyColor(r))));
        REF_CACHE.set(view.name, ref);
      }
      for (const r of rs) {
        const [u, v] = equirectUv(r);
        got.push(lum(toneMap(sample(buf, W, H, u, v))));
      }
      // 区域统计：3×3 网格
      let maxMedDelta = 0;
      let maxVarRatio = 0;
      for (let gy = 0; gy < 3; gy += 1) {
        for (let gx = 0; gx < 3; gx += 1) {
          const idx: number[] = [];
          for (let y = (gy * RH) / 3; y < ((gy + 1) * RH) / 3; y += 1) {
            for (let x = (gx * RW) / 3; x < ((gx + 1) * RW) / 3; x += 1) {
              idx.push(Math.floor(y) * RW + Math.floor(x));
            }
          }
          const mr = median(idx.map((i) => ref[i]));
          const mg = median(idx.map((i) => got[i]));
          const vr = variance(idx.map((i) => ref[i]));
          const vg = variance(idx.map((i) => got[i]));
          maxMedDelta = Math.max(maxMedDelta, Math.abs(mg - mr));
          maxVarRatio = Math.max(maxVarRatio, vr > 1 ? vg / vr : 1);
          void vg;
        }
      }
      let maxAbs = 0;
      let meanAbs = 0;
      const worst: Array<{ d: number; elev: number; azim: number }> = [];
      for (let i = 0; i < ref.length; i += 1) {
        const d = Math.abs(got[i] - ref[i]);
        maxAbs = Math.max(maxAbs, d);
        meanAbs += d;
        const r = rs[i];
        const n = Math.hypot(r[0], r[1], r[2]);
        worst.push({
          d,
          elev: (Math.asin(r[1] / n) * 180) / Math.PI,
          azim: (Math.atan2(r[0], r[2]) * 180) / Math.PI
        });
      }
      meanAbs /= ref.length;
      worst.sort((a, b) => b.d - a.d);
      if (process.env.SKYDIFF_TRACE) {
        console.log(
          '    最差 6 条光线: ' +
            worst
              .slice(0, 6)
              .map((w) => `ΔL${w.d.toFixed(1)}@仰${w.elev.toFixed(1)}°/方位${w.azim.toFixed(0)}°`)
              .join(' ')
        );
      }
      console.log(
        `  ${view.name.padEnd(22)} 区域中位 ΔL 最大 ${maxMedDelta.toFixed(2)} · ` +
          `区域方差保留 ${(Math.min(1, maxVarRatio) * 100).toFixed(1)}% · ` +
          `全图 |ΔL| 均值 ${meanAbs.toFixed(2)} / 最大 ${maxAbs.toFixed(1)}`
      );
    }
  }
}

main();
