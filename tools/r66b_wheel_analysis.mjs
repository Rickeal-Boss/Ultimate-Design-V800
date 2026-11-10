/**
 * r66b_wheel_analysis.mjs — 轮毂 GLB 截面分析：数辐条、量外径/深度、找涡轮开窗。
 * 用法: node tools/r66b_wheel_analysis.mjs <glb>
 * 轮轴 = Y（bbox Y 0-1.04）；轮面在 X-Z 平面。
 * 输出：径向剖面（r 带 × 面片密度）、角向剖面（每 5° 扇区顶点数 → 数辐条）。
 */
import fs from 'node:fs';

const path = process.argv[2];
const buf = fs.readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

// 读 binary chunk
const binOffset = 20 + jsonLen;
const binLen = buf.readUInt32LE(binOffset);
const bin = buf.subarray(binOffset + 8, binOffset + 8 + binLen);

// 拿第一个 mesh 的 position accessor
const mesh = json.meshes[0];
const prim = mesh.primitives[0];
const posAcc = json.accessors[prim.attributes.POSITION];
const bv = json.bufferViews[posAcc.bufferView];
const byteOffset = (bv.byteOffset ?? 0) + (posAcc.byteOffset ?? 0);
const stride = bv.byteStride ?? 12; // float32 x3
const count = posAcc.count;

const V = new Float32Array(count * 3);
for (let i = 0; i < count; i++) {
  const o = byteOffset + i * stride;
  V[i * 3] = buf.readFloatLE(bin.byteOffset + o);
  V[i * 3 + 1] = buf.readFloatLE(bin.byteOffset + o + 4);
  V[i * 3 + 2] = buf.readFloatLE(bin.byteOffset + o + 8);
}

// 轮心：X/Z 取 bbox 中心，Y 取 0（轴沿 Y）
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
for (let i = 0; i < count; i++) {
  const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
}
const cx = (minX + maxX) / 2;
const cz = (minZ + maxZ) / 2;
console.log(`axis=Y  center XZ=(${cx.toFixed(4)}, ${cz.toFixed(4)})`);
console.log(`bbox: X[${minX.toFixed(3)},${maxX.toFixed(3)}] d=${(maxX - minX).toFixed(3)}  Y[${minY.toFixed(3)},${maxY.toFixed(3)}] h=${(maxY - minY).toFixed(3)}  Z[${minZ.toFixed(3)},${maxZ.toFixed(3)}] d=${(maxZ - minZ).toFixed(3)}`);
console.log(`外径(r) ≈ ${(((maxX - minX) + (maxZ - minZ)) / 4).toFixed(4)}  深度(Y) = ${(maxY - minY).toFixed(4)}`);
console.log(`verts=${count}`);

// 径向 + 角向统计（在 X-Z 平面投影）
const NB_R = 30;      // 径向 bin
const NB_A = 72;      // 角向 bin（每 5°）
const rHist = new Array(NB_R).fill(0);
const aHist = new Array(NB_A).fill(0);
const yHist = new Array(20).fill(0);
let rMax = 0;
for (let i = 0; i < count; i++) {
  const dx = V[i * 3] - cx;
  const dz = V[i * 3 + 2] - cz;
  const y = V[i * 3 + 1];
  const r = Math.hypot(dx, dz);
  if (r > rMax) rMax = r;
  const ri = Math.min(NB_R - 1, Math.floor((r / (rMax + 1e-6)) * NB_R));
  rHist[ri]++;
  const ang = Math.atan2(dz, dx);
  const ai = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * NB_A) % NB_A;
  aHist[ai]++;
  const yi = Math.min(19, Math.floor(((y - minY) / (maxY - minY + 1e-6)) * 20));
  yHist[yi]++;
}

console.log('\n=== 径向剖面 (r/rMax 带 : 顶点数) ===');
for (let i = 0; i < NB_R; i++) {
  const bar = '█'.repeat(Math.round((rHist[i] / Math.max(...rHist)) * 40));
  console.log(`r ${(i / NB_R).toFixed(2)}-${((i + 1) / NB_R).toFixed(2)} (${((i / NB_R) * rMax).toFixed(3)}-${(((i + 1) / NB_R) * rMax).toFixed(3)}): ${String(rHist[i]).padStart(6)} ${bar}`);
}

console.log('\n=== 角向剖面 (每 5° 扇区顶点数 → 数辐条/开窗周期) ===');
// 找峰（辐条）与谷（开窗）
const maxA = Math.max(...aHist);
let peaks = 0;
const peakIdx = [];
for (let i = 0; i < NB_A; i++) {
  const prev = aHist[(i - 1 + NB_A) % NB_A];
  const next = aHist[(i + 1) % NB_A];
  if (aHist[i] > prev && aHist[i] >= next && aHist[i] > maxA * 0.5) {
    peaks++;
    peakIdx.push(i);
  }
}
console.log(`检测到径向峰(辐条候选)数: ${peaks}  峰位(扇区×5°): ${peakIdx.map((i) => i * 5).join(',')}`);
for (let i = 0; i < NB_A; i++) {
  const bar = '█'.repeat(Math.round((aHist[i] / maxA) * 30));
  console.log(`${String(i * 5).padStart(3)}°: ${String(aHist[i]).padStart(5)} ${bar}`);
}

console.log('\n=== 轴向(Y)剖面 (深度分布) ===');
const maxYh = Math.max(...yHist);
for (let i = 0; i < 20; i++) {
  const bar = '█'.repeat(Math.round((yHist[i] / maxYh) * 40));
  console.log(`y ${(i / 20).toFixed(2)}-${((i + 1) / 20).toFixed(2)}: ${String(yHist[i]).padStart(6)} ${bar}`);
}
