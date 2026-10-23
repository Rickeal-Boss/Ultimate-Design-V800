/**
 * 远景岩体 + 御桥峡谷内衬（R27 重做，R28 删近景崖体）。
 *
 * ── 本轮改了什么（旧残留 → 新环境）─────────────────────────────────────────
 * 旧：两圈 MeshBasic + 顶点色的「远山素环」，配色粉紫→褐的三段渐变、平顶圆包轮廓。
 *     参考图（2497fab5 / 7cd7329c）里城堡两侧是**灰白崖体 + 岩石**，远景是浅灰褐/土黄
 *     剪影，不是粉紫霞光山 ⇒ 旧环与参考图不符，用户判定为「旧版环境残留」。
 * 新（R27）：
 *  ① 远景环改**岩石语言**：色取 R27_PALETTE.rockCliff #665a4d（近环）/ rockWarm #816e55
 *     （远环）；细节对比按实测 13.7（白石 6.9 的 **2 倍**）给强噪声，节理走**纵向**
 *     （vision §02「不规则块状 + 垂直节理」，不是水平沉积层理）。
 *  ② 材质由 MeshBasic 换成 **MeshLambertMaterial**（吃光 + 吃雾）。旧 MeshBasic 既不
 *     受光也不随方位变化，远景永远是一块平涂渐变贴图。
 *  ③ 新增**御桥峡谷内衬**：Road.buildGround 在走廊里不铺地面（否则盖住桥下峡谷、
 *     并与桥面 z-fighting），这里补上峡谷的岩壁 + 谷底，深 VIADUCT.gorgeDepth。
 *
 * ── R28（CLIFF_POLICY，audit §1.6 + V H6，主理人拍板）──────────────────────
 *  ④ **近景崖体 buildCliffs 整删**（连同 CLIFF_X_VIADUCT / CLIFF_X_INNER / CLIFF_RUN
 *     常量）：`verify/r27_final/viaduct_side.png` 实证巨型平滑丘体吞掉御桥与城堡
 *     （G4/P1），参考图崖体是块状巨岩+垂直节理+阶梯石台、与城堡嵌合，不是圆锥沙丘。
 *     删后 QA 侧机位不再有「x>230 崖体避让」约束。
 *  ⑤ 远景环内收 2600/2200 → **1600/1200**（缺陷 B：雾密度 12e-5 下 2200~2600m 处
 *     exp 衰减仅 3~8%，远环读作硬边带）+ **环顶顶点色向雾色插值**做空气透视
 *     （底 0.15 → 顶 0.55 混向 ACTIVE_ENV.fog.color），环顶剪影融进天光。
 *  ⑥ 峡谷内衬保留（CLIFF_POLICY.keepGorge），深度随 VIADUCT.gorgeDepth 同步 ——
 *     R28 从 R27 的削值 60 恢复实测 **66.5**（读常量即得，见 buildGorge）。
 *  ⑦ 块状岩台（V G4 形制）= 可选远景装饰，默认**不做**
 *     （CLIFF_POLICY.blockyTerrace='optional-off'）；若做须 |x|>80 且不遮挡 QA_VIEWS。
 *
 * ── 明度红线（vision §02）───────────────────────────────────────────────
 * 白石 : 岩石 ≈ **1.6 : 1 ~ 2 : 1**。岩石明度**不许抬到跟白石齐平** —— 抬平了整张图
 * 会失去「白石城 + 灰褐崖」的层次，读成一块灰糊。故岩石顶点色一律以
 * R27_PALETTE.rockCliff / rockWarm 为顶，只向下扰动，不向上（雾色插值除外 ——
 * 那是空气透视，混向的是雾不是亮部）。
 *
 * ── 预算 ───────────────────────────────────────────────────────────────
 * 远景环 ~1040 tri + 峡谷内衬 ~2.9k tri ≈ **4k tri / 2 DC**（R28 删崖体 ~3.2k tri）
 * （整帧红线 R27_BUDGET.frameTri = 320,000，本线增量建议 ≤40k ⇒ 余量充足）。
 */
import * as THREE from 'three';
import { MeshLambertMaterial } from 'three';
import { ACTIVE_ENV } from '../../config/environment';
import { R27_PALETTE, VIADUCT } from './r28Layout';

/** 近景岩石（峡谷壁）albedo —— Rock_CliffCoastal5 实测中位 */
const ROCK_NEAR = new THREE.Color(R27_PALETTE.rockCliff);
/** 远景岩石 albedo —— DarkRockDesert 实测中位（更亮更暖 = 空气透视） */
const ROCK_FAR = new THREE.Color(R27_PALETTE.rockWarm);
/** 雾色（空气透视混色目标）——与场景雾同源，L3 调 fog.color 时自动跟随 */
const HAZE = new THREE.Color(ACTIVE_ENV.fog.color);
/** 环底混雾量（远处岩脚贴地，轻混即可） */
const HAZE_BOTTOM = 0.15;
/** 环顶混雾量（缺陷 B：环顶剪影融进天光，消除硬边带） */
const HAZE_TOP = 0.55;

/**
 * 光照增益（**截图反演值，别拍脑袋改**）。
 *
 * 口径：顶点色是 albedo（未 tonemap）。MeshBasic 会把它原样送出（≈ 渲染 L110）；
 * 换成 Lambert 之后输出 = albedo × Σ辐照度/π × 本增益，同一片岩石在受光/背光面上
 * 会拉开很大的差。两个增益分别对着 `verify/r27_env2/` 的实拍调：
 *  · NEAR（峡谷壁，DoubleSide）：相机贴近、主光掠射，NdotL 分布宽 ⇒ 1.8；
 *  · FAR （远景环，BackSide）：内表面朝原点，而太阳在 −Z（城堡方向）⇒ 玩家视线里的
 *    那段环**整段背光**（NdotL<0），只剩 hemi 0.34 + fill + env，故要抬到 2.6
 *    才有「浅灰褐剪影」而不是「一条黑带」。
 */
const ROCK_GAIN_NEAR = 1.8;
const ROCK_GAIN_FAR = 2.6;

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
    // 远景岩环（BackSide：从圈内看）。R28 半径内收 2600/2200 → 1600/1200 + 环顶
    // 混雾（缺陷 B），见 buildRing。
    // ⚠ R29 更正（实测定罪）：1200 环在 z=−1200 处横穿城内大街，把 z=−1300 的主殿
    // **整栋遮住**（verify/r29_check/inner_street.png：街尽头是一团土黄山体，主殿不可见；
    // 用户截图 6/7 的「雾气色块遮挡」即此物，不是雾）。两个环一律推到主殿之后：
    //   2600 环 → z=−2600 处（主殿后 1300m）、2000 环 → z=−2000 处（后 700m），
    // 既保留「城堡靠山」的天际线，又不再侵入 z∈[−365, −1300] 的行车走廊与视线。
    const sky = emptyPatch();
    this.buildRing(sky, 2600, 320, 3813444, ROCK_FAR, 0.34);
    this.buildRing(sky, 2000, 210, 4864582, ROCK_NEAR, 0.5);
    const skyline = new THREE.Mesh(toGeometry(sky), this.material(ROCK_GAIN_FAR, THREE.BackSide));
    skyline.name = 'terrain-skyline';
    skyline.frustumCulled = false;
    scene.add(skyline);

    // 御桥峡谷内衬（CLIFF_POLICY.keepGorge）。R28：近景崖体 buildCliffs 已整删
    // （CLIFF_POLICY.nearCliffs='delete'）—— 巨型沙丘吞桥实证见文件头 ④。
    const rock = emptyPatch();
    this.buildGorge(rock);
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
   *
   * R28 空气透视（缺陷 B）：顶点色在 rockTint 之后**向雾色插值**，底 HAZE_BOTTOM、
   * 顶 HAZE_TOP —— 环顶剪影融进天光，不再是贴着天空的硬边带；半径内收到
   * 1600/1200 后环带在画面里有体量，远景由「远环 + 雾」兜底（V H6）。
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
      // 顶：u 节理 × 重混雾；底（崖脚）：同一节理 × 遮挡压暗 × 轻混雾
      const kt = rockTint(u, 0.4, 0);
      const kb = rockTint(u, 0.4, bottomShade);
      tmp.copy(base).multiplyScalar(kt).lerp(HAZE, HAZE_TOP);
      out.col.push(tmp.r, tmp.g, tmp.b);
      tmp.copy(base).multiplyScalar(kb).lerp(HAZE, HAZE_BOTTOM);
      out.col.push(tmp.r, tmp.g, tmp.b);
      if (i < SEG) {
        const b = origin + i * 2;
        out.idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
  }

  /**
   * 御桥峡谷内衬：走廊（|x| ≤ VIADUCT.totalHalf / z ∈ [VIADUCT.zFar, VIADUCT.zNear]）
   * 的岩壁 + 谷底，深 VIADUCT.gorgeDepth（R27 曾削到 60 控 tri，R28 恢复实测 66.5）。
   *
   * 与 Road.buildGround 的槽口**严格同点**：壁顶 y = −0.02（大地同高）、壁脚/谷底
   * y = −gorgeDepth。壁面朝内（向走廊中心），站在桥上往两侧看就是 66.5m 深的峡谷。
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
}
