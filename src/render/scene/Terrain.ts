/**
 * 远景岩体 + 御桥峡谷内衬 + 崖体（R27 重做，「完全使用新环境模型」）。
 *
 * ── 本轮改了什么（旧残留 → 新环境）─────────────────────────────────────────
 * 旧：两圈 MeshBasic + 顶点色的「远山素环」，配色粉紫→褐的三段渐变、平顶圆包轮廓。
 *     参考图（2497fab5 / 7cd7329c）里城堡两侧是**灰白崖体 + 岩石**，远景是浅灰褐/土黄
 *     剪影，不是粉紫霞光山 ⇒ 旧环与参考图不符，用户判定为「旧版环境残留」。
 * 新：
 *  ① 远景环改**岩石语言**：色取 R27_PALETTE.rockCliff #665a4d（近环）/ rockWarm #816e55
 *     （远环）；细节对比按实测 13.7（白石 6.9 的 **2 倍**）给强噪声，节理走**纵向**
 *     （vision §02「不规则块状 + 垂直节理」，不是水平沉积层理）。
 *  ② 材质由 MeshBasic 换成 **MeshLambertMaterial**（吃光 + 吃雾）。旧 MeshBasic 既不
 *     受光也不随方位变化，远景永远是一块平涂渐变贴图。
 *  ③ 新增**御桥峡谷内衬**：Road.buildGround 在走廊里不铺地面（否则盖住桥下峡谷、
 *     并与桥面 z-fighting），这里补上峡谷的岩壁 + 谷底，深 VIADUCT.gorgeDepth = 60。
 *  ④ 新增**崖体**（沿御桥两侧 |x| > 24.7、城内段 |x| > 20）：几何线的工作面是
 *     |x| ≤ VIADUCT.totalHalf + 8 = 24.7，之外归本文件堆崖。
 *
 * ── 明度红线（vision §02）───────────────────────────────────────────────
 * 白石 : 岩石 ≈ **1.6 : 1 ~ 2 : 1**。岩石明度**不许抬到跟白石齐平** —— 抬平了整张图
 * 会失去「白石城 + 灰褐崖」的层次，读成一块灰糊。故岩石顶点色一律以
 * R27_PALETTE.rockCliff / rockWarm 为顶，只向下扰动，不向上。
 *
 * ── 预算 ───────────────────────────────────────────────────────────────
 * 远景环 ~1040 tri + 峡谷内衬 ~2.6k tri + 崖体 ~3.2k tri ≈ **6.8k tri / 2 DC**
 * （整帧红线 R27_BUDGET.frameTri = 320,000，本线增量建议 ≤40k ⇒ 余量充足）。
 */
import * as THREE from 'three';
import { MeshLambertMaterial } from 'three';
import { INNER, R27_PALETTE, VIADUCT } from './r27Layout';

/** 近景岩石（崖体/峡谷壁）albedo —— Rock_CliffCoastal5 实测中位 */
const ROCK_NEAR = new THREE.Color(R27_PALETTE.rockCliff);
/** 远景岩石 albedo —— DarkRockDesert 实测中位（更亮更暖 = 空气透视） */
const ROCK_FAR = new THREE.Color(R27_PALETTE.rockWarm);

/**
 * 光照增益（**截图反演值，别拍脑袋改**）。
 *
 * 口径：顶点色是 albedo（未 tonemap）。MeshBasic 会把它原样送出（≈ 渲染 L110）；
 * 换成 Lambert 之后输出 = albedo × Σ辐照度/π × 本增益，同一片岩石在受光/背光面上
 * 会拉开很大的差。两个增益分别对着 `verify/r27_env2/` 的实拍调：
 *  · NEAR（崖体/峡谷壁，DoubleSide）：相机贴近、主光掠射，NdotL 分布宽 ⇒ 1.8；
 *  · FAR （远景环，BackSide）：内表面朝原点，而太阳在 −Z（城堡方向）⇒ 玩家视线里的
 *    那段环**整段背光**（NdotL<0），只剩 hemi 0.34 + fill + env，故要抬到 2.6
 *    才有「浅灰褐剪影」而不是「一条黑带」。
 */
const ROCK_GAIN_NEAR = 1.8;
const ROCK_GAIN_FAR = 2.6;

/** 崖体内缘：御桥段退到几何线工作面之外（VIADUCT.totalHalf + 8 = 24.7） */
const CLIFF_X_VIADUCT = VIADUCT.totalHalf + 8;
/** 崖体内缘：城内段退到建筑之后（INNER.faceHalf = 15.5 ⇒ 取 20） */
const CLIFF_X_INNER = 20;
/** 崖体横向进深（内缘 → 外脚） */
const CLIFF_RUN = 190;

/* ═══════════════════ 值噪声（确定性，禁止 Math.random） ═══════════════════ */

function hash2(ix: number, iy: number): number {
  const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** 双线性平滑插值的值噪声，返回 0..1 */
function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

/** 4 阶分形噪声，归一化到 0..1 */
function fbm2(x: number, y: number): number {
  let v = 0;
  let a = 0.5;
  let fx = x;
  let fy = y;
  for (let o = 0; o < 4; o += 1) {
    v += a * noise2(fx, fy);
    fx *= 2.07;
    fy *= 2.07;
    a *= 0.5;
  }
  return v / 0.9375;
}

/**
 * 岩面色调系数（乘在 albedo 上，只向下压、不向上抬 —— 明度红线）。
 *
 * `u` = 沿岩面横向的坐标（米 / 节理尺度），`v` = 高度（米 / 节理尺度）。
 * **纵向节理**：u 方向频率高（5.5 周期/单位）、v 方向频率低（0.35）⇒ 条纹沿竖直方向
 * 拉长，读作垂直节理而非水平层理（vision §02 / measure §06.1 `ROCK_JOINT_DIR`）。
 * `shade` = 0..1 的遮挡量（谷底/崖脚更暗）。
 */
function rockTint(u: number, v: number, shade: number): number {
  const joint = fbm2(u * 5.5, v * 0.35);
  const grain = noise2(u * 3.1 + 11.3, v * 0.9 + 4.7);
  // 0.78 … 1.06：平均 0.92（≈ albedo 的九折），带宽 ±16%（白石 ±8% 的 2 倍）
  const k = 0.78 + 0.2 * joint + 0.08 * grain;
  return k * (1 - 0.45 * shade);
}

/* ═══════════════════ 网格累加器 ═══════════════════ */

interface Patch {
  pos: number[];
  col: number[];
  idx: number[];
}

const emptyPatch = (): Patch => ({ pos: [], col: [], idx: [] });

function toGeometry(patch: Patch): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(patch.pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(patch.col, 3));
  geo.setIndex(patch.idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 铺一张 (nu+1)×(nv+1) 的四边形网格。
 * `flip` 只翻绕序（决定正面朝哪边），几何本身不变。
 */
function addGrid(
  out: Patch,
  nu: number,
  nv: number,
  at: (i: number, j: number) => readonly [number, number, number],
  tint: (i: number, j: number) => number,
  base: THREE.Color,
  flip: boolean
): void {
  const origin = out.pos.length / 3;
  const tmp = new THREE.Color();
  for (let j = 0; j <= nv; j += 1) {
    for (let i = 0; i <= nu; i += 1) {
      const p = at(i, j);
      out.pos.push(p[0], p[1], p[2]);
      tmp.copy(base).multiplyScalar(tint(i, j));
      out.col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  const row = nu + 1;
  for (let j = 0; j < nv; j += 1) {
    for (let i = 0; i < nu; i += 1) {
      const a = origin + j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      if (flip) out.idx.push(a, c, b, c, d, b);
      else out.idx.push(a, b, c, b, d, c);
    }
  }
}

/* ═══════════════════ Terrain ═══════════════════ */

export class Terrain {
  constructor(scene: THREE.Scene) {
    // 远景岩环（BackSide：从圈内看）
    const sky = emptyPatch();
    this.buildRing(sky, 2600, 260, 3813444, ROCK_FAR, 0.34);
    this.buildRing(sky, 2200, 170, 4864582, ROCK_NEAR, 0.5);
    const skyline = new THREE.Mesh(toGeometry(sky), this.material(ROCK_GAIN_FAR, THREE.BackSide));
    skyline.name = 'terrain-skyline';
    skyline.frustumCulled = false;
    scene.add(skyline);

    // 峡谷内衬 + 崖体（DoubleSide：峡谷从内看、崖体从外看）
    const rock = emptyPatch();
    this.buildGorge(rock);
    this.buildCliffs(rock, VIADUCT.zNear + 20, VIADUCT.zFar - 20, CLIFF_X_VIADUCT, 8, 915371);
    this.buildCliffs(rock, INNER.zNear, INNER.zFar, CLIFF_X_INNER, 10, 2648173);
    const rockMesh = new THREE.Mesh(toGeometry(rock), this.material(ROCK_GAIN_NEAR, THREE.DoubleSide));
    rockMesh.name = 'terrain-rock';
    rockMesh.frustumCulled = false;
    scene.add(rockMesh);
  }

  private material(gain: number, side: THREE.Side): MeshLambertMaterial {
    return new MeshLambertMaterial({
      color: new THREE.Color(gain, gain, gain),
      vertexColors: true,
      side,
      // 远景岩体必须吃雾（旧 MeshBasic 环是这块场景里唯一不随距离衰减的东西）
      fog: true
    });
  }

  /**
   * 远景岩环：一圈竖直岩壁（底 y=−10，顶 = 轮廓高度）。
   *
   * 轮廓 = 3 项低频正弦定主脊 + 1 项高频（47π，指数 0.5 做尖峰）+ LCG 破整齐，
   * 沿用 R26 的「三角波尖顶」做法（3 项正弦叠出来是圆包，远看像雾团不像山）。
   * 逐站色偏改成 **纵向节理**：沿方位角高频、沿高度不变 ⇒ 竖条纹。
   */
  private buildRing(
    out: Patch,
    radius: number,
    heightScale: number,
    seed: number,
    base: THREE.Color,
    bottomShade: number
  ): void {
    const origin = out.pos.length / 3;
    const tmp = new THREE.Color();
    const SEG = 260;
    const heights: number[] = [];
    for (let i = 0; i <= SEG; i += 1) {
      const t = i / SEG;
      heights.push(
        heightScale *
          (0.26 +
            0.29 * Math.abs(Math.sin(t * Math.PI * 7 + radius)) +
            0.18 * Math.abs(Math.sin(t * Math.PI * 23)) +
            0.32 * Math.pow(Math.abs(Math.sin(t * Math.PI * 47 + 0.9)), 0.5) +
            0.18 * noise2(i * 0.37 + seed * 0.013, seed * 0.007))
      );
    }
    heights[SEG] = heights[0]; // 闭合接缝

    for (let i = 0; i <= SEG; i += 1) {
      const angle = (i / SEG) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const h = heights[i];
      // 沿方位角的节理（u 用弧长 / 30m 一节，v 恒 0.4 ⇒ 竖条纹贯穿全高）
      const u = (i / SEG) * ((Math.PI * 2 * radius) / 30);
      out.pos.push(x, -10, z, x, h, z);
      // 顶：u 节理；底（崖脚）：同一节理 × 遮挡压暗，读作岩壁根部的阴影
      const kt = rockTint(u, 0.4, 0);
      const kb = rockTint(u, 0.4, bottomShade);
      tmp.copy(base).multiplyScalar(kt);
      out.col.push(tmp.r, tmp.g, tmp.b);
      tmp.copy(base).multiplyScalar(kb);
      out.col.push(tmp.r, tmp.g, tmp.b);
      if (i < SEG) {
        const b = origin + i * 2;
        out.idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
  }

  /**
   * 御桥峡谷内衬：走廊（|x| ≤ VIADUCT.totalHalf / z ∈ [VIADUCT.zFar, VIADUCT.zNear]）
   * 的岩壁 + 谷底，深 VIADUCT.gorgeDepth。
   *
   * 与 Road.buildGround 的槽口**严格同点**：壁顶 y = −0.02（大地同高）、壁脚/谷底
   * y = −gorgeDepth。壁面朝内（向走廊中心），站在桥上往两侧看就是 60m 深的峡谷。
   * 谷底向下 45% 压暗（shade），读作见不到阳光的谷底阴影。
   */
  private buildGorge(out: Patch): void {
    const half = VIADUCT.totalHalf;
    const zNear = VIADUCT.zNear;
    const zFar = VIADUCT.zFar;
    const top = -0.02;
    const bed = -VIADUCT.gorgeDepth;
    const zStep = 10;
    const yStep = 5;
    const nz = Math.max(2, Math.round((zNear - zFar) / zStep));
    const ny = Math.max(2, Math.round((top - bed) / yStep));

    // ── 两侧岩壁（法线朝走廊中心）──
    for (const side of [-1, 1] as const) {
      addGrid(
        out,
        nz,
        ny,
        (i, j) => {
          const z = zNear + ((zFar - zNear) * i) / nz;
          const y = top + ((bed - top) * j) / ny;
          // 壁面向岩体一侧起伏（**只向外凹，不向内凸**，避免侵占走廊与桥面争空间）
          const wob = 2.4 * fbm2(z * 0.06 + (side > 0 ? 31.7 : 5.1), y * 0.05);
          const zw = 1.6 * (noise2(z * 0.11 + 2.3, y * 0.09 + side * 7.7) - 0.5);
          return [side * (half + wob), y, z + zw];
        },
        (i, j) => {
          const z = zNear + ((zFar - zNear) * i) / nz;
          return rockTint(z / 30, j / ny, 0.15 + 0.85 * (j / ny));
        },
        ROCK_NEAR,
        side > 0
      );
    }

    // ── 两端封口（z = zNear 朝 +z，z = zFar 朝 −z）──
    const nx = 4;
    for (const [zEnd, flip] of [
      [zNear, true],
      [zFar, false]
    ] as const) {
      addGrid(
        out,
        nx,
        ny,
        (i, j) => {
          const x = -half + ((2 * half) * i) / nx;
          const y = top + ((bed - top) * j) / ny;
          const zw = 2.0 * (noise2(x * 0.13 + 8.9, y * 0.08) - 0.5);
          return [x, y, zEnd + (zEnd === zNear ? -Math.abs(zw) : Math.abs(zw))];
        },
        (i, j) => rockTint(i / nx, j / ny, 0.15 + 0.85 * (j / ny)),
        ROCK_NEAR,
        flip
      );
    }

    // ── 谷底（法线朝上）──
    addGrid(
      out,
      nx,
      nz,
      (i, j) => {
        const x = -half + ((2 * half) * i) / nx;
        const z = zNear + ((zFar - zNear) * j) / nz;
        return [x, bed + 1.1 * (fbm2(x * 0.09 + 17.3, z * 0.05) - 0.5), z];
      },
      (i, j) => rockTint(i / nx, j / nz, 1),
      ROCK_NEAR,
      false
    );
  }

  /**
   * 崖体：沿 z 扫掠一条 6 点横剖面，双侧成对堆在走廊外侧。
   *
   * 剖面（dx 为相对内缘的比例，y 为相对峰高的比例）：
   *   内脚(0, 0) → 0.09/0.16 → **主峰 0.18/1.0** → 0.38/0.62 → 0.64/0.26 → 外脚(1, 0)
   * 峰高逐站用双频噪声（22…40m）+ 两端各 40m  taper 到 3m（收进地面，不留断墙）。
   */
  private buildCliffs(
    out: Patch,
    zFrom: number,
    zTo: number,
    xIn: number,
    step: number,
    seed: number
  ): void {
    const PROFILE: readonly (readonly [number, number])[] = [
      [0, 0],
      [0.09, 0.16],
      [0.18, 1.0],
      [0.38, 0.62],
      [0.64, 0.26],
      [1.0, 0]
    ];
    const FOOT_Y = -0.6; // 内外脚埋进地面以下，避免与 y=−0.02 的大地留缝
    const nz = Math.max(2, Math.round(Math.abs(zFrom - zTo) / step));
    const span = Math.abs(zFrom - zTo);

    for (const side of [-1, 1] as const) {
      // 峰高序列（先算好，两端 taper）
      const crest: number[] = [];
      for (let k = 0; k <= nz; k += 1) {
        const z = zFrom + ((zTo - zFrom) * k) / nz;
        const big = fbm2(z * 0.011 + seed * 0.0007, 1.7);
        const small = noise2(z * 0.055 + seed * 0.0031, 9.2);
        let h = 22 + 13 * big + 5 * small;
        const edge = Math.min(k, nz - k) * step; // 离最近端点的距离
        if (edge < 40) h = 3 + ((h - 3) * edge) / 40; // 两端 40m 收进地面
        crest.push(h);
      }
      void span;

      addGrid(
        out,
        nz,
        PROFILE.length - 1,
        (i, j) => {
          const z = zFrom + ((zTo - zFrom) * i) / nz;
          const [fx, fy] = PROFILE[j];
          const h = crest[i];
          // 横向也抖一点（±6m），峰线才不是一条直墙；内脚不动，绝不越进走廊
          const jitter = j === 0 ? 0 : (noise2(z * 0.07 + j * 3.3, seed * 0.0011) - 0.5) * 12;
          const x = side * (xIn + fx * CLIFF_RUN + (j === 0 ? 0 : jitter));
          const y = fy <= 0 ? FOOT_Y : FOOT_Y + h * fy;
          return [x, y, z + (j === 0 ? 0 : (noise2(z * 0.09 + j, seed * 0.0021) - 0.5) * 6)];
        },
        (i, j) => {
          const [fx, fy] = PROFILE[j];
          const z = zFrom + ((zTo - zFrom) * i) / nz;
          // 高处的岩面更亮（少遮挡），崖脚/背阴的凹处更暗
          return rockTint(z / 30 + fx * 6, 0.4 + j * 0.2, 0.42 - 0.42 * fy);
        },
        ROCK_NEAR,
        side > 0
      );
    }
  }
}
