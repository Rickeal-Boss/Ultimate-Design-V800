/**
 * R43 落地审查 · 极简 PNG 编解码（零依赖，node zlib）
 *   · encode：RGBA8 / filter 0 / colorType 6
 *   · decode：bitDepth 8 / colorType 2(RGB) 6(RGBA) / 0(灰度) / 4(灰度+α)，非隔行
 * 只为本轮探针出「平涂 ID 图」与读用户截图取色用。
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** @param {number} w @param {number} h @param {Uint8Array} rgba */
export function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** @returns {{width:number,height:number,rgba:Uint8Array}} */
export function decodePNG(buf) {
  let p = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error('only bitDepth 8 supported, got ' + bitDepth);
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (!channels) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let q = 0;
  for (let y = 0; y < height; y += 1) {
    const f = raw[q];
    q += 1;
    cur.set(raw.subarray(q, q + stride));
    q += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      cur[i] = v & 0xff;
    }
    const o = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      if (channels === 4) {
        out[o + x * 4] = cur[s];
        out[o + x * 4 + 1] = cur[s + 1];
        out[o + x * 4 + 2] = cur[s + 2];
        out[o + x * 4 + 3] = cur[s + 3];
      } else if (channels === 3) {
        out[o + x * 4] = cur[s];
        out[o + x * 4 + 1] = cur[s + 1];
        out[o + x * 4 + 2] = cur[s + 2];
        out[o + x * 4 + 3] = 255;
      } else if (channels === 1) {
        out[o + x * 4] = out[o + x * 4 + 1] = out[o + x * 4 + 2] = cur[s];
        out[o + x * 4 + 3] = 255;
      } else {
        out[o + x * 4] = out[o + x * 4 + 1] = out[o + x * 4 + 2] = cur[s];
        out[o + x * 4 + 3] = cur[s + 1];
      }
    }
    prev.set(cur);
  }
  return { width, height, rgba: out };
}
