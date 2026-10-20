/**
 * tailgatePanel.ts —— V800 尾门「上下折线」手写几何（R20-1 / Regime H）
 *
 * 为什么手写网格而不是 ExtrudeGeometry：
 *   spec 的 `deformationStack` / `edgeTreatment` 是生成器**不读**的散文字段，挤出基元
 *   只能给出一块平板（实测 distinctZ(z@1e-3) = 2：只有 0 与 0.07 两个 z 平面）。
 *   用户从 R18 起反复指认「尾门缺上下折线」，唯一的落地路径是把尾门外表面的 z 变成
 *   (x, y) 的解析函数 —— 那需要规则网格采样，挤出基元的 steps:1 常面做不到。
 *
 * 局部帧（与工厂几何逐位同一坐标系，替换几何时不需要任何矩阵补偿）：
 *   父节点 `node_tailgate_25`（pivot，name「尾门模块__pivot」）位于 spec position
 *   (0, 1.055, -2.836)，rotation 0 / scale 1；几何绕自身原点展开：
 *     x ∈ [-0.84589 .. +0.84589]  车身左右
 *     y ∈ [-0.525 .. +0.135]      节点相对高度（世界 y = 1.055 + y ⇒ 0.53 .. 1.19）
 *     z ∈ [0 .. 0.07]             0 = 尾门外表面（世界 −2.836）；0.07 = 朝车头方向的背面
 *
 * ⚠️ bbox 契约（红线）：`V800Adapter.ts` 的 `tailgate-maextro`（L2677-2681）与
 *   `license-plate-rear`（L2711）位置**全部由 tailgate 子树 world bbox 推导**
 *   （center.y ± 0.36/0.16·size.y、后表面 +15/20mm）。所以：
 *     · x ±0.84589 / y −0.525..0.135 / z 0..0.070 三项必须逐位不变；
 *     · 折线**只能内凹（+z 车头向）**，绝不能外凸脊（外凸顶大 size.z ⇒ 贴花整体外移）。
 *
 * R20-1c（读成「裂缝」返工）：13:09 的像素复检给出相邻 6px 亮度极差 201~202
 * （上折线 L 28↔245、下 L 36↔238），观感是接缝不是钣金线。根因是**参数把我给的设计
 * 做尖了**：槽壁 25%（14°）、两肩硬拆点、总宽只有 24~28mm ⇒ 一侧壁吃天空、一侧壁全暗。
 * 本版按裁决改成「加宽 + 变浅 + 圆角化」：
 *   · 槽总宽 44mm（半宽 0.022），槽深 2.4/2.6mm ⇒ 侧壁斜率 ~11~13%（6.3~7.4°）
 *   · 槽底 4mm 平底（±0.002）+ smoothstep 过渡（C¹，无 180° 回头尖点）
 *   · **共享顶点 + 解析梯度**：不再按行带拆点造 1 帧硬边 —— 折线的「线感」由曲率突变
 *     给出，不靠法线断裂。旧的硬边正是 200 级对比的来源。
 *   · |x| > 0.72 起 smoothstep 衰减、0.84589 处深度归零（折线不撞尾灯壳，真车也收进 D 柱）
 *
 * z 红线（实测口径已由落地审查修正）：车体尾面**真实曲面**在世界 −2.820（不是 bbox 的
 * −2.830），尾门正后方最小余量 **14mm**。本版外表面最深点 z_local ≈ 0.0042（世界 −2.8318），
 * 相对 −2.820 仍有 11.8mm，远在安全区；且 z_local ≤ 0.006 这条名义线也守得住。
 */
import * as THREE from 'three';

/* ================================================================
 * 1. 站表常量（改折线位置/断面只改这里）
 * ================================================================ */

/** 面板局部 y 下沿（世界 0.530） */
const Y_MIN = -0.525;
/** 面板局部 y 上沿（世界 1.190） */
const Y_MAX = 0.135;
const HEIGHT = Y_MAX - Y_MIN;
/** 中段半宽（实测旧件 0.8458884 = 0.93 × taper 0.9780066 × geometry.scale 0.93） */
const HALF_W_MID = 0.84589;
/** 上下端头半宽（旧件四角 0.05 斜切：0.88/0.93 比 ⇒ 0.80040） */
const HALF_W_END = 0.80041;
/** 斜切高度 0.05（与 spec profile2D 的 [±0.88, ±(0.525|0.135)] 转角落点一致） */
const CHAMFER_Y = 0.05;
/** 面板厚度：背面停在 0.07，与旧件 z 上界逐位一致（贴花 bbox 契约） */
const DEPTH = 0.07;

/** x 向分格：44 段（冠面 + 折线两端淡出都在 x 上，2cm 一列足够） */
const SEG_X = 44;
/** y 向基础（粗）分格 */
const SEG_Y_COARSE = 14;

/**
 * 上折线：世界 0.980（离铬条下沿 1.082 有 100mm、离后牌上沿 0.817 有 163mm）。
 * R20-1c 裁决：原 −0.010（世界 1.045）离铬条只有 32mm，容易被读成「灯带边缘」。
 * R20-1d：平底 4→10mm、壁-底之间加 r6 圆角、槽总宽 44→52mm（补偿平底+圆角吃掉的壁长）。
 */
const CREASE_UP = { y: -0.075, half: 0.026, depth: 0.0024, flat: 0.005, fillet: 0.006 } as const;
/** 下折线：世界 0.655（离后牌下沿 0.691 有 36mm、离后杠上沿 0.560 有 95mm） */
const CREASE_LO = { y: -0.4, half: 0.026, depth: 0.0026, flat: 0.005, fillet: 0.006 } as const;

/** 横向冠面振幅（边缘相对中央内凹；R20-1b 已裁定，勿动） */
const CROWN_X = 0.0017;
/** 纵向冠面振幅（上下沿相对中高内凹；R20-1b 已裁定，勿动） */
const CROWN_Y = 0.0008;

/** 折线横向淡出：|x| 超过 START 起衰减，到 END（面板半宽）深度归零 */
const FADE_START = 0.72;
const FADE_END = HALF_W_MID;

/**
 * 旧 UV 车道：工厂挤出件的外表面 UV 就是 profile2D 原坐标（实测 u ∈ ±0.93、
 * v ∈ [-0.525, 0.135]），不是 0..1。paint-upper 当前**无 map**（适配层 R10 已撤图集、
 * refTextures 规则表也不含该材质），所以 UV 数值不影响采样；但保持同一车道可以避免
 * 给落地审查的 #uvassert 判据制造一次无意义的基线跳变。故沿用旧车道：
 *   u = x / 0.90954614 (= 0.93 × 0.9780066)，v = y
 */
const UV_X_PER_METER = 1.0994494;

/* ================================================================
 * 2. 对外导出的站表（QA / 报告口径）
 * ================================================================ */

export interface TailgateCreaseStation {
  readonly label: string;
  /** 节点局部 y */
  readonly y: number;
  /** 世界 y（= 1.055 + localY） */
  readonly worldY: number;
  /** 单侧槽宽（m）：从槽底沿到深度归零处的距离 */
  readonly halfWidth: number;
  /** 槽总宽（m）—— 落地审查 B5「槽口 ≥16mm」判据用这个 */
  readonly totalWidth: number;
  /** 槽底平底半宽（m） */
  readonly flatHalf: number;
  /** 槽底退让深度（m，朝车头方向） */
  readonly depth: number;
  /** 侧壁平均斜率 = depth / (halfWidth − flatHalf) */
  readonly wallSlope: number;
  /** 侧壁倾角（度） */
  readonly wallAngleDeg: number;
}

export const TAILGATE_CREASE_STATIONS: readonly TailgateCreaseStation[] = [
  {
    label: 'upper',
    y: CREASE_UP.y,
    worldY: 1.055 + CREASE_UP.y,
    halfWidth: CREASE_UP.half,
    totalWidth: CREASE_UP.half * 2,
    flatHalf: CREASE_UP.flat,
    depth: CREASE_UP.depth,
    wallSlope: CREASE_UP.depth / (CREASE_UP.half - CREASE_UP.flat),
    wallAngleDeg: (Math.atan(CREASE_UP.depth / (CREASE_UP.half - CREASE_UP.flat)) * 180) / Math.PI
  },
  {
    label: 'lower',
    y: CREASE_LO.y,
    worldY: 1.055 + CREASE_LO.y,
    halfWidth: CREASE_LO.half,
    totalWidth: CREASE_LO.half * 2,
    flatHalf: CREASE_LO.flat,
    depth: CREASE_LO.depth,
    wallSlope: CREASE_LO.depth / (CREASE_LO.half - CREASE_LO.flat),
    wallAngleDeg: (Math.atan(CREASE_LO.depth / (CREASE_LO.half - CREASE_LO.flat)) * 180) / Math.PI
  }
];

/* ================================================================
 * 3. 解析面（唯一真源：位置由它给出，法线取它的中心差分梯度）
 * ================================================================ */

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** C¹ 平滑阶梯（两端导数为 0，所以折线槽与母面之间没有硬折边） */
function smoothstep01(value: number): number {
  const c = clamp01(value);
  return c * c * (3 - 2 * c);
}

/** 面板外轮廓半宽：中段等宽、上下 5cm 斜切收进（复刻旧件实测轮廓） */
function halfWidthAt(y: number): number {
  if (y <= Y_MIN + CHAMFER_Y) {
    const k = clamp01((y - Y_MIN) / CHAMFER_Y);
    return HALF_W_END + (HALF_W_MID - HALF_W_END) * k;
  }
  if (y >= Y_MAX - CHAMFER_Y) {
    const k = clamp01((Y_MAX - y) / CHAMFER_Y);
    return HALF_W_END + (HALF_W_MID - HALF_W_END) * k;
  }
  return HALF_W_MID;
}

/** 冠面（基线）：中央最鼓、四周内凹 —— 形式与任务书的「中央外凸」等价（整体平移） */
function crownAt(x: number, y: number): number {
  const u = x / halfWidthAt(y);
  const t = clamp01((y - Y_MIN) / HEIGHT);
  return CROWN_X * u * u + CROWN_Y * (1 - Math.sin(Math.PI * t));
}

/** 单条折线的断面几何（R20-1d：平底 + 两侧 r6 圆角 + 直壁，全部 C¹ 相接） */
interface CreaseGeometrySpec {
  readonly half: number;
  readonly depth: number;
  readonly flat: number;
  readonly fillet: number;
}
interface CreaseProfile {
  /** 平底半宽 */
  readonly flat: number;
  /** 圆角水平跨度 */
  readonly a: number;
  /** 圆角垂直落差 */
  readonly v: number;
  /** 直壁水平长度 */
  readonly L: number;
  /** 直壁斜率（= 全断面峰值斜率） */
  readonly m: number;
  /** 槽深 */
  readonly depth: number;
  /** 深度归零处（= half） */
  readonly edge: number;
  /** 圆角半径 */
  readonly R: number;
}

/**
 * 解断面参数：给定 (平底半宽 f, 半槽宽 H+f, 槽深 D, 圆角半径 R)，求直壁斜率 m。
 * 约束式：`D = 2·R(1−cosθ) + m·(H − 2R·sinθ)`，θ = atan(m)
 * （等式含义：深度 = 两段圆角的垂直落差 + 直壁的垂直落差；水平方向 R·sinθ 被圆角吃掉）
 * 左端单调递增 ⇒ 二分求解，模块加载时算一次。
 */
function solveCreaseProfile(spec: CreaseGeometrySpec): CreaseProfile {
  const H = spec.half - spec.flat;
  const R = spec.fillet;
  const D = spec.depth;
  const depthOf = (m: number): number => {
    const sinT = m / Math.sqrt(1 + m * m);
    const cosT = 1 / Math.sqrt(1 + m * m);
    return 2 * R * (1 - cosT) + m * (H - 2 * R * sinT);
  };
  let lo = 0;
  let hi = 2;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (depthOf(mid) < D) lo = mid;
    else hi = mid;
  }
  const m = (lo + hi) / 2;
  const sinT = m / Math.sqrt(1 + m * m);
  const cosT = 1 / Math.sqrt(1 + m * m);
  return {
    flat: spec.flat,
    a: R * sinT,
    v: R * (1 - cosT),
    L: H - 2 * R * sinT,
    m,
    depth: D,
    edge: spec.half,
    R
  };
}

const PROFILE_UP = solveCreaseProfile(CREASE_UP);
const PROFILE_LO = solveCreaseProfile(CREASE_LO);

/**
 * 单条折线的断面 z(dy)：dy 单位米。
 * 五段：平底（斜 0）→ 下圆角（0 → −m，法线连续）→ 直壁（−m 恒定）→ 上圆角（−m → 0）→ 母面。
 * 每段交界处 z 与 dz/ddy 都对齐（C¹），所以**没有任何折点**。
 */
function creaseSectionAt(dy: number, p: CreaseProfile): number {
  const d = Math.abs(dy);
  if (d <= p.flat) return p.depth;
  if (d >= p.edge) return 0;
  const { flat: f, a, v, L, m, depth: D, R, edge } = p;
  if (d <= f + a) {
    const x = d - f;
    return D - R + Math.sqrt(Math.max(0, R * R - x * x));
  }
  if (d <= f + a + L) return D - v - m * (d - (f + a));
  const x = edge - d;
  return R - Math.sqrt(Math.max(0, R * R - x * x));
}

/** 横向淡出：面板两端把折线收掉（0 → 1） */
function creaseFadeAt(x: number): number {
  const ax = Math.abs(x);
  if (ax <= FADE_START) return 1;
  if (ax >= FADE_END) return 0;
  return 1 - smoothstep01((ax - FADE_START) / (FADE_END - FADE_START));
}

/** 折线总退让量（两条折线不重叠，直接相加）× 横向淡出 */
function grooveAt(x: number, y: number): number {
  const raw = creaseSectionAt(y - CREASE_UP.y, PROFILE_UP) + creaseSectionAt(y - CREASE_LO.y, PROFILE_LO);
  return raw * creaseFadeAt(x);
}

/** 外表面 z(x,y)：0 = 旧尾门平面（世界 −2.836），全部增量朝 +z（车头向）内凹 */
export function tailgateSurfaceZ(x: number, y: number): number {
  return crownAt(x, y) + grooveAt(x, y);
}

/**
 * 外法线（朝 −z 车尾）：n = (∂z/∂x, ∂z/∂y, −1) 归一。
 * 用**解析面的中心差分**取梯度：本版曲面是 C¹ 的（smoothstep 两端导数为 0），
 * 所以差分梯度在折线处也是连续的 —— 这正是「靠曲率突变给线感、不靠法线断裂」的实现。
 */
function surfaceNormalAt(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
  const h = 5e-4;
  const dzdx = (tailgateSurfaceZ(x + h, y) - tailgateSurfaceZ(x - h, y)) / (2 * h);
  const dzdy = (tailgateSurfaceZ(x, y + h) - tailgateSurfaceZ(x, y - h)) / (2 * h);
  const len = Math.hypot(dzdx, dzdy, 1);
  return out.set(dzdx / len, dzdy / len, -1 / len);
}

/* ================================================================
 * 4. 行站表（粗分 + 折线带加密；本版不再为硬边拆点，所以只是采样密度）
 * ================================================================ */

/**
 * 折线带内的加密偏移（米）。平底 ±2mm 必须落在站点上，过渡段 2→22mm 用
 * 2/5/9/14/20mm 五档采样，smoothstep 的曲率足够表达。
 */
const CREASE_ROW_OFFSETS = [0, 0.002, 0.005, 0.009, 0.014, 0.02] as const;

function buildRowStations(): number[] {
  const stations: number[] = [];
  for (let i = 1; i < SEG_Y_COARSE; i += 1) stations.push(Y_MIN + (HEIGHT * i) / SEG_Y_COARSE);
  for (const crease of [CREASE_LO, CREASE_UP]) {
    for (const off of CREASE_ROW_OFFSETS) {
      stations.push(crease.y - off);
      if (off > 0) stations.push(crease.y + off);
    }
  }
  stations.sort((a, b) => a - b);
  const kept: number[] = [];
  for (const y of stations) {
    if (y <= Y_MIN + 1e-6 || y >= Y_MAX - 1e-6) continue;
    if (kept.length > 0 && y - kept[kept.length - 1] < 1.5e-3) continue; // 去掉粗分与加密行的碎条
    kept.push(y);
  }
  return [Y_MIN, ...kept, Y_MAX];
}

/* ================================================================
 * 5. 几何装配
 * ================================================================ */

/**
 * 尾门面板几何：规则网格外表面（含上下折线 V 槽 + 双向冠面）+ 一圈 70mm 深的裙边。
 *
 * 裙边的作用只有一个：让 z 上界仍然落在 0.07。适配层的 MAEXTRO 贴花/车牌按
 * 「tailgate 子树世界 bbox」定位（后表面 − 15mm / − 20mm），z 上界一动，贴花就会
 * 沉进面板里。裙边 ~300 tri 换 bbox 契约稳定，值。
 */
export function createTailgateCreaseGeometry(): THREE.BufferGeometry {
  const rows = buildRowStations();
  const cols = SEG_X + 1;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const normal = new THREE.Vector3();

  // ---- 外表面：共享顶点的规则网格（法线全程连续，折线靠曲率突变给线感）----
  for (let i = 0; i < rows.length; i += 1) {
    const y = rows[i];
    const hw = halfWidthAt(y);
    for (let j = 0; j < cols; j += 1) {
      const u = -1 + (2 * j) / SEG_X;
      const x = u * hw;
      positions.push(x, y, tailgateSurfaceZ(x, y));
      surfaceNormalAt(x, y, normal);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(x * UV_X_PER_METER, y);
    }
  }
  for (let i = 0; i < rows.length - 1; i += 1) {
    for (let j = 0; j < SEG_X; j += 1) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // (a, c, d) / (a, d, b) ⇒ 从 −z（车尾）看逆时针
      indices.push(a, c, d);
      indices.push(a, d, b);
    }
  }

  // ---- 裙边：外轮廓闭合环朝 +z 拉伸到 DEPTH ----
  const loop: { x: number; y: number; z: number }[] = [];
  const pushPoint = (u: number, y: number): void => {
    const x = u * halfWidthAt(y);
    loop.push({ x, y, z: tailgateSurfaceZ(x, y) });
  };
  for (let j = 0; j < cols; j += 1) pushPoint(-1 + (2 * j) / SEG_X, Y_MIN);
  for (let i = 1; i < rows.length; i += 1) pushPoint(1, rows[i]);
  for (let j = SEG_X - 1; j >= 0; j -= 1) pushPoint(-1 + (2 * j) / SEG_X, Y_MAX);
  // 左列从「上沿下一行」起：上沿左角已由顶部行 j=0 压入，重复点会退化成 2 个空三角
  for (let i = rows.length - 2; i >= 1; i -= 1) pushPoint(-1, rows[i]);
  const skirtBase = positions.length / 3;
  for (let k = 0; k < loop.length; k += 1) {
    const prev = loop[(k - 1 + loop.length) % loop.length];
    const next = loop[(k + 1) % loop.length];
    const cur = loop[k];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    // 逆时针环（从 +z 看）的水平外法线 = (ty, −tx) 归一
    const nx = ty / tl;
    const ny = -tx / tl;
    for (const z of [cur.z, DEPTH]) {
      positions.push(cur.x, cur.y, z);
      normals.push(nx, ny, 0);
      uvs.push(cur.x * UV_X_PER_METER, cur.y);
    }
  }
  for (let k = 0; k < loop.length; k += 1) {
    const a0 = skirtBase + 2 * k;
    const a1 = a0 + 1;
    const b0 = skirtBase + 2 * ((k + 1) % loop.length);
    const b1 = b0 + 1;
    indices.push(a0, b0, b1);
    indices.push(a0, b1, a1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
