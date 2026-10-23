/**
 * 天空着色预测器：把 sky shader（含 fbm 云、暖晕、云两段色）连同 three 的
 * ACESFilmicToneMapping(exposure 0.85) + sRGB 编码一起在 node 里复算，
 * 用来把「天空偏亮/偏暗」这种主观判断换成具体数值，并与参考图采样对齐。
 *
 * 用法：node tools/r26_sky_predict.mjs [zenith=0x4e5468 mid=0x585e6e glow=0.13 bandMin=0.16 horizon=0xd8c9b2 clouds=0.85]
 *       不带参数 = 复算当前 ACTIVE_ENV 的成品像素值。
 *
 * ⚠ 铁律（R26b 定案）：参考图的采样值是 tonemap **之后**的像素，EnvPreset 里填的是 tonemap
 *   **之前**的授权色。本项目的渲染器是 ACESFilmicToneMapping + toneMappingExposure 0.85，
 *   低亮度段近似 ×1.4 —— 直接把采样 hex 填进 preset 会稳定偏暗 40 级左右。
 *   任何天空/雾/云的调色都必须先过这个脚本，否则就是凭感觉调。
 */

// ── three 的管线：hex → 线性工作色 ───────────────────────────────────────
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
function hexToLinear(hex) {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255)
  ];
}
const EXPOSURE = 0.85;

function rrtAndOdtFit(v) {
  const a = v.map((x) => x * (x + 0.0245786) - 0.000090537);
  const b = v.map((x) => x * (0.983729 * x + 0.432951) + 0.238081);
  return a.map((x, i) => x / b[i]);
}
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
const mul = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

function toneMap(linear) {
  const scaled = linear.map((c) => (c * EXPOSURE) / 0.6);
  const aced = rrtAndOdtFit(mul(ACES_IN, scaled));
  const out = mul(ACES_OUT, aced).map((c) => Math.min(1, Math.max(0, c)));
  return out.map((c) => Math.round(linearToSrgb(c) * 255));
}

// ── shader 复刻 ────────────────────────────────────────────────────────
const fract = (x) => x - Math.floor(x);
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => a.map((v, i) => mix(v, b[i], t));
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const hash = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
function noise2(x, y) {
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
function fbm(x, y) {
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

// ── 候选参数（改这里对比）─────────────────────────────────────────────
const ARGV = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')).map(([k, v]) => [k, Number(v)]));
const P = {
  zenith: hexToLinear(ARGV.zenith ?? 0x4e5468),
  mid: hexToLinear(ARGV.mid ?? 0x585e6e),
  horizon: hexToLinear(ARGV.horizon ?? 0xd8c9b2),
  ground: hexToLinear(0x4b4038),
  sunColor: hexToLinear(0xfff0d8),
  cloudAmount: ARGV.clouds ?? 0.85,
  glowAmp: ARGV.glow ?? 0.13,
  bandMin: ARGV.bandMin ?? 0.16,
  // 云的两色：线性工作值 = (mid lerp target 比例) × 缩放
  cloudLitLerp: 0.3,
  cloudLitScale: 0.45,
  cloudDarkLerp: 0.55,
  cloudDarkScale: 0.32
};
const sun = [Math.sin((195 * Math.PI) / 180) * Math.cos((12 * Math.PI) / 180), Math.sin((12 * Math.PI) / 180), Math.cos((195 * Math.PI) / 180) * Math.cos((12 * Math.PI) / 180)];
const cloudLit = mix3(P.mid, P.horizon, P.cloudLitLerp).map((c) => c * P.cloudLitScale);
const cloudDark = mix3(P.mid, P.ground, P.cloudDarkLerp).map((c) => c * P.cloudDarkScale);

function sky(dir) {
  const n = Math.hypot(...dir);
  const d = dir.map((c) => c / n);
  const h = d[1];
  let col;
  if (h > 0) {
    const t1 = smoothstep(0, 0.18, h);
    const t2 = smoothstep(0.12, 0.65, h);
    col = mix3(P.horizon, P.mid, t1);
    col = mix3(col, P.zenith, t2);
  } else {
    col = mix3(P.horizon, P.ground, smoothstep(0, 0.08, -h));
  }
  const sn = Math.hypot(...sun);
  const sd = Math.max(0, (d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]) / sn);
  let glow = sd ** 4 * P.glowAmp + sd ** 16 * P.glowAmp;
  const bandWeight = 1 - smoothstep(0, 0.12, Math.abs(h));
  glow *= mix(P.bandMin, 1, bandWeight);
  const gate = smoothstep(-0.1, 0.02, h);
  col = col.map((c, i) => c + P.sunColor[i] * glow * gate);
  col = col.map((c, i) => c + P.sunColor[i] * smoothstep(0.999, 0.9996, sd) * 0.55);

  if (h > 0) {
    const ux = d[0] / (h + 0.12);
    const uz = d[2] / (h + 0.12);
    const px = ux * 0.6 * 1.3 + 3.1;
    const py = uz * 1.6 * 1.3 + 0.7;
    const base = fbm(px, py);
    const dx = ux * 0.6 * 3.4 - 1.7;
    const dy = uz * 1.6 * 3.4 + 2.3;
    const detail = fbm(dx, dy);
    const cover = smoothstep(0.44, 0.8, base) * (0.72 + (detail - 0.5) * 0.55);
    const vertical = smoothstep(0.015, 0.15, h) * (1 - smoothstep(0.28, 0.9, h));
    const c = Math.min(0.94, Math.max(0, cover * P.cloudAmount * vertical));
    const nearSun = mix3(cloudLit, P.sunColor.map((x) => x * 1.12), sd ** 2 * 0.85 + 0.15);
    const cloud = mix3(nearSun, cloudDark, smoothstep(0.34, 0.86, detail));
    col = mix3(col, cloud, c);
  }
  return toneMap(col);
}

// ── 采样点：按「看向城堡方向」定义 ────────────────────────────────────
const deg = (d) => (d * Math.PI) / 180;
const look = (elev, azim) => [Math.sin(deg(azim)) * Math.cos(deg(elev)), Math.sin(deg(elev)), Math.cos(deg(azim)) * Math.cos(deg(elev))];
const points = [
  ['天顶（h=1.0）', [0, 1, 0], '参考 天顶 #494c5d(77)'],
  ['仰角 45° / 朝城堡(180°)', look(45, 180), '参考 天空左上 #61585d(90)'],
  ['仰角 20° / 朝城堡', look(20, 180), '（过渡区）'],
  ['仰角 4° / 朝城堡（暖晕带内）', look(4, 180), '参考 地平线暖晕 #beb098(177)'],
  ['仰角 4° / 正对太阳(195°)', look(4, 195), '暖晕核心'],
  ['仰角 4° / 背对太阳(15°)', look(4, 15), '暖晕带外（应接近 horizon 色）']
];

console.log('视线方向                      预测 sRGB         亮度   参考');
for (const [name, dir, ref] of points) {
  const rgb = sky(dir);
  const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  console.log(
    `${name.padEnd(28)} (${String(rgb[0]).padStart(3)},${String(rgb[1]).padStart(3)},${String(rgb[2]).padStart(3)})   ${l.toFixed(0).padStart(3)}   ${ref}`
  );
}
