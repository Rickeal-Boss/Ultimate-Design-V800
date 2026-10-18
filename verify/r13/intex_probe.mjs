/**
 * r13 探针 · intex_probe.mjs —— 无头导出 interiorTextures.ts 生成的贴图 PNG 供目检。
 *
 * 手法（沿用 .img2threejs/tools/a2_dom_shim.mjs 思路）：安装最小 DOM/Canvas shim，
 * 但本 shim 实现了**软件光栅器**（只覆盖 interiorTextures.ts 用到的 API 子集：
 * fillRect / 折线 stroke / arc+fill（整圆快路径）/ 线性渐变 / 同心径向渐变 /
 * getImageData 全幅），因此 Node 侧就能得到真实像素，再经内置 PNG 编码器写出。
 * 用法：node verify/r13/intex_probe.mjs（cwd 任意，路径相对本文件解析）。
 * 注意：本文件是 .mjs —— 必须是纯 JS。
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = HERE;
const BUNDLE = join(HERE, '.r13_intex.bundle.mjs');

/* ================================================================
 * 1) 最小 2D 软件光栅 shim
 * ================================================================ */

function parseColorStr(s) {
  if (typeof s !== 'string') return [0, 0, 0, 1];
  s = s.trim();
  if (s[0] === '#') {
    const n = parseInt(s.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((v) => parseFloat(v));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return [0, 0, 0, 1];
}

function makeContext(canvas) {
  let fb = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  const st = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, globalAlpha: 1 };
  let subpaths = []; // { pts: [[x,y]...], arc: {cx,cy,r}|null }
  let cur = null;

  const colorAt = (style, x, y) => {
    if (typeof style === 'string') return parseColorStr(style);
    let t;
    if (style.kind === 'linear') {
      const dx = style.x1 - style.x0;
      const dy = style.y1 - style.y0;
      const l2 = dx * dx + dy * dy || 1;
      t = ((x - style.x0) * dx + (y - style.y0) * dy) / l2;
    } else {
      const d = Math.hypot(x - style.x0, y - style.y0);
      t = (d - style.r0) / (style.r1 - style.r0 || 1);
    }
    const stops = style.stops;
    if (t <= stops[0].o) return stops[0].c;
    if (t >= stops[stops.length - 1].o) return stops[stops.length - 1].c;
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].o) {
        const A = stops[i - 1];
        const B = stops[i];
        const u = (t - A.o) / (B.o - A.o || 1);
        return [
          A.c[0] + (B.c[0] - A.c[0]) * u,
          A.c[1] + (B.c[1] - A.c[1]) * u,
          A.c[2] + (B.c[2] - A.c[2]) * u,
          A.c[3] + (B.c[3] - A.c[3]) * u,
        ];
      }
    }
    return stops[stops.length - 1].c;
  };

  const blend = (idx, c, a) => {
    const ia = 1 - a;
    fb[idx] = c[0] * a + fb[idx] * ia;
    fb[idx + 1] = c[1] * a + fb[idx + 1] * ia;
    fb[idx + 2] = c[2] * a + fb[idx + 2] * ia;
    fb[idx + 3] = 255 * a + fb[idx + 3] * ia;
  };

  const alpha = (c) => c[3] * st.globalAlpha;

  const thickSeg = (x0, y0, x1, y1, hw) => {
    const minx = Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1));
    const maxx = Math.min(canvas.width - 1, Math.ceil(Math.max(x0, x1) + hw + 1));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1));
    const maxy = Math.min(canvas.height - 1, Math.ceil(Math.max(y0, y1) + hw + 1));
    if (minx > maxx || miny > maxy) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy;
    const r2 = hw * hw;
    for (let yy = miny; yy <= maxy; yy++) {
      for (let xx = minx; xx <= maxx; xx++) {
        const cx = xx + 0.5;
        const cy = yy + 0.5;
        let t = l2 > 0 ? ((cx - x0) * dx + (cy - y0) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ddx = cx - (x0 + t * dx);
        const ddy = cy - (y0 + t * dy);
        if (ddx * ddx + ddy * ddy <= r2) {
          const c = colorAt(st.strokeStyle, cx, cy);
          blend((yy * canvas.width + xx) * 4, c, alpha(c));
        }
      }
    }
  };

  return {
    get fillStyle() { return st.fillStyle; },
    set fillStyle(v) { st.fillStyle = v; },
    get strokeStyle() { return st.strokeStyle; },
    set strokeStyle(v) { st.strokeStyle = v; },
    get lineWidth() { return st.lineWidth; },
    set lineWidth(v) { st.lineWidth = v; },
    get globalAlpha() { return st.globalAlpha; },
    set globalAlpha(v) { st.globalAlpha = v; },
    lineCap: 'butt',

    beginPath() { subpaths = []; cur = null; },
    closePath() {},
    moveTo(x, y) { cur = { pts: [[x, y]], arc: null }; subpaths.push(cur); },
    lineTo(x, y) {
      if (!cur) { cur = { pts: [[x, y]], arc: null }; subpaths.push(cur); }
      else cur.pts.push([x, y]);
    },
    arc(cx, cy, r, a0, a1) {
      const n = Math.max(24, Math.min(256, Math.ceil(r * 1.5)));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6;
      const sp = { pts, arc: full ? { cx, cy, r } : null };
      subpaths.push(sp);
      cur = sp;
    },

    fillRect(x, y, w, h) {
      const x0 = Math.max(0, Math.floor(x));
      const x1 = Math.min(canvas.width, Math.ceil(x + w));
      const y0 = Math.max(0, Math.floor(y));
      const y1 = Math.min(canvas.height, Math.ceil(y + h));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const c = colorAt(st.fillStyle, xx + 0.5, yy + 0.5);
          blend((yy * canvas.width + xx) * 4, c, alpha(c));
        }
      }
    },

    fill() {
      // 快路径：单条整圆弧（interiorTextures 的圆面均为此形态）
      if (subpaths.length === 1 && subpaths[0].arc) {
        const { cx, cy, r } = subpaths[0].arc;
        const x0 = Math.max(0, Math.floor(cx - r));
        const x1 = Math.min(canvas.width, Math.ceil(cx + r));
        const y0 = Math.max(0, Math.floor(cy - r));
        const y1 = Math.min(canvas.height, Math.ceil(cy + r));
        const r2 = r * r;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const dx = xx + 0.5 - cx;
            const dy = yy + 0.5 - cy;
            if (dx * dx + dy * dy <= r2) {
              const c = colorAt(st.fillStyle, xx + 0.5, yy + 0.5);
              blend((yy * canvas.width + xx) * 4, c, alpha(c));
            }
          }
        }
        return;
      }
      // 通用：偶奇扫描线填充（逐像素取色以支持渐变）
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (const sp of subpaths) {
        for (const [qx, qy] of sp.pts) {
          if (qx < minx) minx = qx;
          if (qx > maxx) maxx = qx;
          if (qy < miny) miny = qy;
          if (qy > maxy) maxy = qy;
        }
      }
      const px0 = Math.max(0, Math.floor(minx));
      const px1 = Math.min(canvas.width - 1, Math.ceil(maxx));
      const py0 = Math.max(0, Math.floor(miny));
      const py1 = Math.min(canvas.height - 1, Math.ceil(maxy));
      for (let yy = py0; yy <= py1; yy++) {
        const yc = yy + 0.5;
        const xs = [];
        for (const sp of subpaths) {
          const pts = sp.pts;
          const len = pts.length;
          for (let i = 0; i < len; i++) {
            const p = pts[i];
            const q = pts[(i + 1) % len];
            if (p === q) continue;
            if (p[1] <= yc !== q[1] <= yc) {
              xs.push(p[0] + ((yc - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
            }
          }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
          const xb = Math.min(canvas.width - 1, Math.floor(xs[k + 1] - 0.5));
          for (let xx = xa; xx <= xb; xx++) {
            const c = colorAt(st.fillStyle, xx + 0.5, yc);
            blend((yy * canvas.width + xx) * 4, c, alpha(c));
          }
        }
      }
    },

    stroke() {
      const hw = Math.max(0.5, st.lineWidth / 2);
      for (const sp of subpaths) {
        const pts = sp.pts;
        for (let i = 0; i + 1 < pts.length; i++) {
          thickSeg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], hw);
        }
      }
    },

    createLinearGradient(x0, y0, x1, y1) {
      const g = { kind: 'linear', x0, y0, x1, y1, stops: [] };
      g.addColorStop = (o, c) => {
        g.stops.push({ o, c: parseColorStr(c) });
        g.stops.sort((p, q) => p.o - q.o);
      };
      return g;
    },
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      // interiorTextures 只使用同心径向渐变（x0===x1 && y0===y1）
      const g = { kind: 'radial', x0, y0, r0, r1, stops: [] };
      g.addColorStop = (o, c) => {
        g.stops.push({ o, c: parseColorStr(c) });
        g.stops.sort((p, q) => p.o - q.o);
      };
      return g;
    },

    getImageData(sx, sy, sw, sh) {
      if (sx !== 0 || sy !== 0 || sw !== canvas.width || sh !== canvas.height) {
        throw new Error('r13 shim: 只支持全幅 getImageData');
      }
      return { width: sw, height: sh, data: new Uint8ClampedArray(fb) };
    },
  };
}

function installShim() {
  const makeCanvasEl = () => {
    const el = {
      width: 300,
      height: 150,
      style: {},
      __ctx: null,
      getContext(kind) {
        if (kind !== '2d') return null;
        if (!this.__ctx) this.__ctx = makeContext(this);
        return this.__ctx;
      },
      toDataURL() { return ''; },
      addEventListener() {},
      removeEventListener() {},
    };
    return el;
  };
  const g = globalThis;
  if (typeof g.document === 'undefined') {
    g.document = {
      createElement(tag) {
        if (tag === 'canvas') return makeCanvasEl();
        return { style: {}, addEventListener() {}, removeEventListener() {} };
      },
      createElementNS(_ns, tag) { return this.createElement(tag); },
      getElementById() { return null; },
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {}, removeChild() {} },
      documentElement: { style: {} },
    };
  }
  if (typeof g.window === 'undefined') {
    g.window = {
      devicePixelRatio: 2,
      location: { hash: '', search: '', href: 'http://localhost/' },
      addEventListener() {},
      removeEventListener() {},
      innerWidth: 1920,
      innerHeight: 1080,
      requestAnimationFrame: () => 0,
    };
  }
  if (typeof g.self === 'undefined') g.self = g.window;
  if (typeof g.requestAnimationFrame === 'undefined') g.requestAnimationFrame = () => 0;
  if (typeof g.cancelAnimationFrame === 'undefined') g.cancelAnimationFrame = () => {};
  if (typeof g.HTMLCanvasElement === 'undefined') g.HTMLCanvasElement = class {};
}

/* ================================================================
 * 2) 最小 PNG 编码器（RGBA8 → PNG，filter 0 + zlib deflate）
 * ================================================================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ================================================================
 * 3) 主流程：esbuild 打包 → 生成贴图 → 导出 PNG
 * ================================================================ */

async function main() {
  installShim();
  const { build } = await import('esbuild');
  const src = join(HERE, '..', '..', 'src', 'model', 'interiorTextures.ts');
  await build({
    entryPoints: [src],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile: BUNDLE,
    external: ['three'],
    logLevel: 'warning',
  });
  const mod = await import(pathToFileURL(BUNDLE).href);

  const jobs = [
    ['tex_steering_wheel.png', () => mod.createSteeringWheelTexture()],
    ['tex_steering_hub.png', () => mod.createSteeringHubTexture()],
    ['tex_brake_pedal.png', () => mod.createBrakePedalTexture()],
    ['tex_quilt_warm.png', () => mod.createSeatQuiltTexture('#b08a5a')],
    ['tex_quilt_ivory.png', () => mod.createSeatQuiltTexture('#ddd3c2')],
    ['tex_wood_veneer.png', () => mod.createWoodVeneerTexture()],
  ];

  mkdirSync(OUT, { recursive: true });
  let fail = 0;
  for (const [name, fn] of jobs) {
    try {
      const t0 = performance.now();
      const tex = fn();
      const ms = performance.now() - t0;
      const img = tex.image;
      const ctx = img.getContext('2d');
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      writeFileSync(join(OUT, name), encodePng(img.width, img.height, data));
      console.log(
        `OK  ${name}  ${img.width}x${img.height}  ${ms.toFixed(1)}ms  colorSpace=${tex.colorSpace}  wrap=${tex.wrapS}`
      );
    } catch (err) {
      fail++;
      console.error(`FAIL ${name}: ${err && err.stack ? err.stack : err}`);
    }
  }
  if (fail > 0) process.exit(1);
  console.log('r13 intex probe done.');
}

main();
