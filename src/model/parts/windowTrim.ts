/**
 * windowTrim.ts —— V800 侧窗整圈镀铬包边 + D 柱银色包面（R22-C 手写几何）
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 本文件只产部件 + 材质，不接线。接线由集成层在 batchMergeStatic 之前完成，    │
 * │ 严禁在本文件外改 Adapter / spec / 工厂（三线隔离：spec · adapter · _game）。 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 目标关系（spec componentTree）：
 *   window-belt-l / window-belt-r（窗线镀铬亮条，extrude 0.015×0.02×3.3，
 *   x≈±0.9175 —— 实车比对后**整体被车身侧壁吞掉、不可见**，故整件替换）
 *   → 本部件可见；接线时把 window-belt-l/r 的 pivot 置 visible=false 后挂本组。
 *   dpillar-l / dpillar-r（0.46 长 matte-black 宽块）与 d-pillar-rear-l/r 本体
 *   **不动**；本部件的 D 柱银包面只是叠在其外侧（外扩 ~8mm），不与之干涉。
 *
 * 坐标系（与车身世界系一致，y 上正、z 车头为正）：
 *   x = ±外侧（side=1 → +x 为左/驾驶侧；side=-1 用 group.scale.x=-1 纯镜像）
 *   本 Group 不带任何 position 偏移，直接挂到 root 级（或用 root 的子节点）。
 *
 * ── 几何实测依据（R22 探针对 factory 产物做射线扫描，见
 *    .img2threejs/tools/r22_windowtrim/ 与 verify/r22/windowtrim/README.md）──
 *   1) 侧窗玻璃带（greenhouse-glass）外表面不是平面：随高度内倾（tumblehome）
 *      y=1.20 → x=0.961；y=1.66 → x=0.949；y=1.74 → x≈0.916（顶沿倒角）。
 *   2) 车顶板（roof-panel）侧沿 x=0.970，底面 y≈1.739（顶沿外悬 21~54mm）。
 *   3) body-lower 侧壁 x≈1.006~1.008，在当前工厂产物里一直包到 y≈1.665 ——
 *      即玻璃带下段被车身壁遮住（R22-A body-lower loft 重做后会开窗）。
 *      因此铬条**不能**只贴在玻璃平面上：每个采样点取「该点最外表面 + 3mm」，
 *      玻璃裸露处贴玻璃、车身壁覆盖处贴壁面，任何机位都不会被吞。
 *   4) 带后缘 spec 为 z=−2.82 垂直；但尾部 d-pillar-rear-l 是 x≤1.005 的尾角实体
 *      （z −2.856..−2.766、y≤1.44），贴 −2.82 的铬条会整段埋进去 → 后缘竖段
 *      改到 z=−2.762（实体前表面再前 4mm）。A 柱边为直线
 *      (1.6079,1.1285)→(1.1800,1.7565)；腰带线沿 spec 剖面
 *      (-2.381,1.139)→(1.600,1.1006) 线性下降。
 *
 * ── 铁律对齐 ──
 *   · profile / 绕序：本件不用 ExtrudeGeometry，全部手写三角面 + computeVertexNormals
 *     （非索引 → 每面平面法线，chrome 才有硬边高光）；构建末尾做**全局绕序校正**
 *     （首三角法线 x<0 则整体翻转），保证外侧法线朝 +x。
 *   · 材质独占：r22-trim-chrome / r22-trim-dpillar，零外部图；
 *     userData.sculptMaterial.id 供 V800Adapter 建表（勿并入共享批次）。
 *   · ≤900 tri/侧（实测见 verify/r22/windowtrim/README.md）。
 */
import * as THREE from 'three';

/* ================================================================
 * 0. 常量
 * ================================================================ */

/** 上沿 / A 柱 / 后缘的铬条带宽（m） */
export const W_FRAME = 0.021;
/** 腰带（窗台）段铬条带宽（m）——实车该段明显更宽 */
export const W_BELT = 0.030;
/** 铬条外表面相对车身表面的外扩量（m）——4mm：小于车身曲率误差、又足够避免 z-fighting */
export const PROUD = 0.004;
/** 铬条自身板厚（m）：外侧裙边/内侧收边的 x 落差 */
const TH_SKIRT = 0.013;
const TH_TAIL = 0.0035;
/** D 柱银包面相对玻璃面外扩（m） */
export const DPILLAR_PROUD = 0.008;
/** 玻璃面相对车身外表面外扩（m）——2mm：略低于铬框（4mm），层级正确（玻璃嵌在铬框内） */
export const GLASS_PROUD = 0.002;

/** 材质 id（独占，供 V800Adapter 建表；勿与共享材质合并） */
export const TRIM_MATERIAL_ID = {
  chrome: 'r22-trim-chrome',
  pillar: 'r22-trim-dpillar',
  glass: 'r22-glass-band',
} as const;

/* ================================================================
 * 1. 对外类型
 * ================================================================ */

export interface WindowTrimMaterials {
  /** 镀铬包边（高金属度低粗糙，硬边高光） */
  chrome: THREE.MeshStandardMaterial;
  /** D 柱银色/香槟铬包面（拉丝感，略高于 chrome 粗糙度） */
  pillar: THREE.MeshStandardMaterial;
}

export type PathPt = { z: number; y: number; w: number };

/* ================================================================
 * 2. DLO 路径（侧视 z-y 平面，CCW；外法线 n=(ty,-tz)）
 * ================================================================ */

/**
 * 腰带（窗台）线，取自 spec greenhouse-glass 剖面折线（4 折点线性插值）：
 *   (−2.770,1.160) → (−2.398,1.145) → (−2.381,1.139) → (1.600,1.1006)
 * 后两点之间有 6mm 台阶（剖面本身如此，勿抹平）。
 */
const BELT_KNOTS: [number, number][] = [
  [-2.77, 1.16],
  [-2.398, 1.145],
  [-2.381, 1.139],
  [1.6, 1.1006],
];

export function beltY(z: number): number {
  if (z <= BELT_KNOTS[0][0]) return BELT_KNOTS[0][1];
  for (let i = 0; i < BELT_KNOTS.length - 1; i++) {
    const [z0, y0] = BELT_KNOTS[i];
    const [z1, y1] = BELT_KNOTS[i + 1];
    if (z <= z1) return y0 + ((y1 - y0) * (z - z0)) / (z1 - z0);
  }
  return BELT_KNOTS[BELT_KNOTS.length - 1][1];
}

function buildDloPath(): PathPt[] {
  const P: PathPt[] = [];
  const push = (z: number, y: number, w: number): void => {
    P.push({ z, y, w });
  };

  // ① 前下角（A 柱根窄圆角，向腰带段加宽过渡）
  push(1.598, 1.101, W_BELT);
  push(1.6116, 1.1059, 0.028);
  push(1.615, 1.1181, 0.026);
  push(1.6079, 1.1285, 0.024);

  // ② A 柱边：直线 (1.6079,1.1285) → (1.1800,1.7565)
  const az0 = 1.6079;
  const ay0 = 1.1285;
  const az1 = 1.18;
  const ay1 = 1.7565;
  for (let i = 1; i <= 9; i++) {
    const t = i / 10;
    push(az0 + (az1 - az0) * t, ay0 + (ay1 - ay0) * t, W_FRAME);
  }

  // ③ 顶前圆角 + 顶线（玻璃带上沿 y≈1.760，后段略降 1.7586）
  const topKnots: [number, number][] = [
    [1.1673, 1.7606],
    [-0.3, 1.76],
    [-1.45, 1.762],
    [-1.8, 1.762],
    [-2.7, 1.7586],
  ];
  for (let k = 0; k < topKnots.length - 1; k++) {
    const [z0, y0] = topKnots[k];
    const [z1, y1] = topKnots[k + 1];
    for (let i = 0; i < 3; i++) {
      const t = i / 3;
      push(z0 + (z1 - z0) * t, y0 + (y1 - y0) * t, W_FRAME);
    }
  }
  push(-2.7, 1.7586, W_FRAME);

  // ④ 后上圆角（r≈0.05，收在 z=-2.750 的后缘上）
  push(-2.715, 1.7575, W_FRAME);
  push(-2.732, 1.7535, W_FRAME);
  push(-2.744, 1.7455, W_FRAME);
  push(-2.75, 1.7345, W_FRAME);

  // ⑤ 后缘垂直段 z=-2.750
  //    ⚠ 不用 glass 剖面原值 -2.82：尾部 d-pillar-rear-l 是一块 x≤1.005 的尾角实体
  //    （挤出 z −2.856..−2.766，+6mm 倒边 → 实际前沿 z≈−2.7605，y≤1.44）。
  //    后缘竖段取 −2.750 ⇒ 铬条后侧边落在 −2.7605，与该实体前表面平齐、不互穿。
  push(-2.75, 1.58, W_FRAME);
  push(-2.75, 1.39, W_FRAME);
  push(-2.75, 1.205, W_FRAME);

  // ⑥ 后下圆角（4 段弧，r≈0.04）
  push(-2.748, 1.188, W_FRAME);
  push(-2.7425, 1.1745, W_FRAME);
  push(-2.734, 1.1645, W_FRAME);
  push(-2.7225, 1.1595, W_FRAME);

  // ⑦ 腰带段：y 按 spec 剖面折线；z 采样点固定（-1.775 是滑动门后缘台阶，
  //    body-lower 侧壁在 z≈-1.75 处从 y≤1.14 直跳到 y=1.665，铬条在此处
  //    跟着外扩 —— 多插一个点把 75mm 台阶压在一段内，避免半段被车身吞掉）
  const beltZs = [
    -2.6, -2.381, -2.1, -1.8, -1.775, -1.5, -1.2, -0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9, 1.2,
    1.5, 1.57,
  ];
  for (const z of beltZs) push(z, beltY(z), W_BELT);

  return P;
}

/** 闭合 DLO 轮廓（不含重复首点） */
export const DLO_PATH: PathPt[] = buildDloPath();

/**
 * 各路径点处「车身最外表面 x」（R22 对 factory 产物射线实测；见 README §3）
 * 实测规律（左半 x>0）：
 *   · A 柱段（idx1–13, z 1.61→1.17）  → aplillar-l 0.9675（A 柱件外表面）
 *   · 顶沿段（idx14–22, y≈1.760）      → roof-panel 侧沿 0.9700
 *     ⚠ idx14（z=0.678）独立实测 0.9170，是「紧贴车顶下沿的玻璃倒角」，
 *       不能当贴面；同邻域车顶侧沿=0.970，此处取 0.970 让铬条压在顶沿棱线上。
 *   · idx23/24（z=−2.10/−2.40 顶沿）  → dpillar-l 0.9799/0.9831（宽黑柱高出顶沿 15mm，
 *     铬条必须跟着外扩，否则被它挡掉 0.46m）
 *   · 后缘竖段（idx30–36）             → 玻璃 0.9515~0.9610（tumblehome）
 *   · 腰带后段（idx37–40）             → 玻璃下沿倒角 0.9310~0.9341（落在窗槽里）
 *   · 腰带前段（idx41–50）             → body-lower 侧壁 1.0066~1.0071
 *   · 腰带前末（idx51–53）             → door-panel-fl 0.9750 / 玻璃 0.9599~0.9618
 * 构建时统一再加 PROUD（4mm）；数表与 DLO_PATH 一一对应，长度不符会抛错。
 */
export const OUTER_X: number[] = [
  /* 00 */ 0.9674,
  /* 01 A 柱 */ 0.9675, 0.9675, 0.9675, 0.9675, 0.9675, 0.9675, 0.9675, 0.9675, 0.9675, 0.9675, 0.9675, 0.9675, 0.9675,
  /* 14 顶沿 */ 0.97,
  /* 15 */ 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97,
  /* 23 dpillar */ 0.9799, 0.9831,
  /* 25 顶沿 */ 0.97, 0.97, 0.97, 0.97, 0.97,
  /* 30 后缘 */ 0.9515, 0.9565, 0.961, 0.961, 0.9577, 0.9566, 0.9582,
  /* 37 腰带后段 */ 0.9341, 0.931, 0.931, 0.931,
  /* 41 腰带前段 */ 1.0066, 1.0066, 1.0067, 1.0067, 1.0068, 1.0069, 1.0069, 1.007, 1.0071, 1.0071,
  /* 51 前末 */ 0.975, 0.9618, 0.9599,
];

/* ================================================================
 * 3. 材质工厂（独占，零外部图）
 * ================================================================ */

export function createWindowTrimMaterials(): WindowTrimMaterials {
  const mk = (id: string, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...params });
    m.name = id;
    m.userData.sculptMaterial = { id };
    return m;
  };
  return {
    chrome: mk(TRIM_MATERIAL_ID.chrome, {
      color: 0xdfe3e8,
      metalness: 1.0,
      roughness: 0.11,
      envMapIntensity: 1.35,
    }),
    pillar: mk(TRIM_MATERIAL_ID.pillar, {
      color: 0xd6d7db,
      metalness: 1.0,
      roughness: 0.24,
      envMapIntensity: 1.15,
    }),
  };
}

/* ================================================================
 * 4. 几何构建工具（手写三角面，非索引 → 平面法线 → chrome 硬边）
 * ================================================================ */

type V3 = { x: number; y: number; z: number };

class TriSink {
  readonly pos: number[] = [];

  tri(a: V3, b: V3, c: V3): void {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }

  quad(a: V3, b: V3, c: V3, d: V3): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** 打包成非索引 BufferGeometry；若首三角法线 x<0 则整体翻面（外法线朝 +x） */
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const arr = new Float32Array(this.pos);
    const flip = this.firstTriNormalX(arr) < 0;
    if (flip) {
      // 每个三角内交换第 2、3 顶点 → 反向绕序
      for (let t = 0; t < arr.length; t += 9) {
        for (let k = 0; k < 3; k++) {
          const i1 = t + 3 + k;
          const i2 = t + 6 + k;
          const tmp = arr[i1];
          arr[i1] = arr[i2];
          arr[i2] = tmp;
        }
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    // uv：棱线方向做 u（0..1 循环），横截面方向做 v —— 无贴图，仅供调试/扩展
    const n = arr.length / 3;
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      uv[i * 2] = (i / n) % 1;
      uv[i * 2 + 1] = i % 2;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  private firstTriNormalX(arr: Float32Array): number {
    if (arr.length < 9) return 1;
    const ay = arr[1];
    const az = arr[2];
    const uy = arr[4] - ay;
    const uz = arr[5] - az;
    const vy = arr[7] - ay;
    const vz = arr[8] - az;
    // n = u × v 的 x 分量（ux/vx 不参与该分量，故不声明，避免 noUnusedLocals）
    return uy * vz - uz * vy;
  }
}

/** 闭合折线在 (z,y) 平面上的外法线（CCW 轮廓 → n=(ty,-tz)） */
function outwardNormals(path: PathPt[]): { nz: number; ny: number }[] {
  const N = path.length;
  const out: { nz: number; ny: number }[] = [];
  for (let i = 0; i < N; i++) {
    const p = path[(i - 1 + N) % N];
    const q = path[(i + 1) % N];
    let tz = q.z - p.z;
    let ty = q.y - p.y;
    const L = Math.hypot(tz, ty) || 1;
    tz /= L;
    ty /= L;
    out.push({ nz: ty, ny: -tz });
  }
  return out;
}

/* ================================================================
 * 5. 侧窗整圈铬条（闭合环带）
 * ================================================================ */

/**
 * 沿 DLO 闭合轮廓扫出「卷边铬条」：
 *   横截面 4 点（外裙边 → 外棱 → 内棱 → 内收边），3 条带 × 每段 2 tri。
 *   x 逐点取 OUTER_X（实测最外表面）+ PROUD，因此任何机位都不会被车身吞。
 */
function buildChromeFrame(xAt: (i: number) => number): THREE.BufferGeometry {
  const path = DLO_PATH;
  const N = path.length;
  const nrm = outwardNormals(path);
  const sink = new TriSink();

  type Row = [V3, V3, V3, V3];
  const rows: Row[] = [];
  for (let i = 0; i < N; i++) {
    const { z, y, w } = path[i];
    const { nz, ny } = nrm[i];
    const X = xAt(i) + PROUD;
    const ho = w / 2;
    // 截面点（在 z-y 平面内沿外法线偏移）
    const pe = { z: z + nz * ho, y: y + ny * ho }; // 外缘
    const pi = { z: z - nz * ho, y: y - ny * ho }; // 内缘
    // 内外棱各内收 3mm，形成卷边圆棱
    const ce = { z: pe.z - nz * 0.003, y: pe.y - ny * 0.003 };
    const ci = { z: pi.z + nz * 0.003, y: pi.y + ny * 0.003 };
    rows.push([
      { x: X - TH_SKIRT, y: pe.y, z: pe.z }, // 0 外裙边（回折进车身）
      { x: X, y: ce.y, z: ce.z }, // 1 外棱
      { x: X, y: ci.y, z: ci.z }, // 2 内棱
      { x: X - TH_TAIL, y: pi.y, z: pi.z }, // 3 内收边
    ]);
  }

  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const a = rows[i];
    const b = rows[j];
    sink.quad(a[0], a[1], b[1], b[0]); // 外裙边带
    sink.quad(a[1], a[2], b[2], b[1]); // 正面主带
    sink.quad(a[2], a[3], b[3], b[2]); // 内侧收边带
  }
  return sink.build();
}


/* ================================================================
 * 6.5 侧窗玻璃带（DLO 轮廓填充）
 *
 * body-lower 沿车宽挤出为实心壳、两侧面即挤出端面，greenhouse-glass 在
 * x 0.949~0.961 被外侧蒙皮（x≈1.007）挡住 → 车外看不见玻璃。本件把 DLO
 * 闭合轮廓填充成一块玻璃面，逐顶点贴到「OUTER_X[i] + GLASS_PROUD」——
 * 即比该处车身最外表面高 2mm，使玻璃在车外可读作嵌在铬框内的暗玻璃。
 * ShapeGeometry 对无孔简单多边形只产生轮廓顶点（earcut 不插 Steiner 点），
 * 故每个玻璃顶点都落在 DLO 轮廓上，x 直接取自 OUTER_X，天然贴体。
 * ================================================================ */

function buildGlassBandGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  DLO_PATH.forEach((p, i) => (i === 0 ? shape.moveTo(p.z, p.y) : shape.lineTo(p.z, p.y)));
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape); // 顶点在 XY 平面（z=0），x=DLO.z, y=DLO.y
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  // 每个轮廓顶点就近匹配 OUTER_X 索引（earcut 偶发顶点顺序差异时仍安全）
  const projX = (zi: number, yi: number): number => {
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < DLO_PATH.length; k++) {
      const d = Math.hypot(DLO_PATH[k].z - zi, DLO_PATH[k].y - yi);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return OUTER_X[best] ?? 0.966;
  };
  for (let i = 0; i < n; i++) {
    const zi = pos.getX(i);
    const yi = pos.getY(i);
    const gx = projX(zi, yi) + GLASS_PROUD;
    pos.setXYZ(i, gx, yi, zi);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * 生成一侧的侧窗玻璃带。
 * @param side +1 左（+x）；-1 右（scale.x=-1 纯镜像，与 createWindowTrim 同律）
 * @param material 可选：复用同一份材质实例（左右共用 → 1 DC）
 * @returns Group（局部系 = 车身世界系；userData.sculptComponent.id='greenhouse-glass' 便于接线）
 */
export function createGlassBand(side: 1 | -1, material?: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.name = side === 1 ? 'window-glass-l' : 'window-glass-r';
  group.userData.sculptComponent = { id: 'greenhouse-glass' };
  group.userData.r22 = { part: 'window-glass', side, replaces: 'greenhouse-glass' };

  const mat =
    material ??
    (() => {
      const m = new THREE.MeshPhysicalMaterial({
        color: 0x0a0c10,
        metalness: 0.35,
        roughness: 0.06,
        transparent: true,
        opacity: 0.86,
        envMapIntensity: 1.6,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
        side: THREE.DoubleSide,
      });
      m.name = TRIM_MATERIAL_ID.glass;
      m.userData.sculptMaterial = { id: TRIM_MATERIAL_ID.glass };
      return m;
    })();

  const mesh = new THREE.Mesh(buildGlassBandGeometry(), mat);
  mesh.name = 'trim-glass-band';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);

  if (side === -1) group.scale.x = -1;
  group.updateMatrixWorld(true);
  return group;
}

/** 本侧玻璃三角面数（DLO 填充 ≈ N-2，预算 ≤240 单稳） */
export function countGlassTriangles(group: THREE.Object3D): number {
  let n = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry as THREE.BufferGeometry;
    n += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  });
  return n;
}

/* ================================================================
 * 7. 装配入口
 * ================================================================ */

/**
 * 生成一侧的「侧窗铬框 + D 柱银包面」。
 *
 * @param side  +1 = 左侧（+x，驾驶侧）；-1 = 右侧（用 scale.x=-1 纯镜像）
 * @param materials 可选：复用外部材质实例（左右**必须**共用同一份，否则 DC 翻倍）
 * @returns Group（局部系 = 车身世界系，无 position 偏移）
 */
export function createWindowTrim(side: 1 | -1, materials?: WindowTrimMaterials): THREE.Group {
  if (OUTER_X.length !== DLO_PATH.length) {
    throw new Error(
      `windowTrim: OUTER_X(${OUTER_X.length}) 与 DLO_PATH(${DLO_PATH.length}) 长度不符 —— 改路径必须重测表面 x 表`,
    );
  }
  const mats = materials ?? createWindowTrimMaterials();
  const group = new THREE.Group();
  group.name = side === 1 ? 'window-trim-l' : 'window-trim-r';
  // 与被替换件同 id 便于接线定位；同时标注本件来源
  group.userData.sculptComponent = { id: side === 1 ? 'window-belt-l' : 'window-belt-r' };
  group.userData.r22 = { part: 'window-trim', side, replaces: side === 1 ? 'window-belt-l' : 'window-belt-r' };

  const xAt = (i: number): number => OUTER_X[i] ?? 0.966;

  const chromeMesh = new THREE.Mesh(buildChromeFrame(xAt), mats.chrome);
  chromeMesh.name = 'trim-chrome-frame';
  chromeMesh.castShadow = false;
  chromeMesh.receiveShadow = false;
  group.add(chromeMesh);

  // 注：D 柱银包面改由 spec dpillar-l/r（transform 修正 + dpillar-silver 材质）承担，
  // 此处不再挂手写银包面，避免与 spec 件双几何 z-fighting（R22-D 定罪结论）。

  if (side === -1) group.scale.x = -1;
  group.updateMatrixWorld(true);
  return group;
}

/** 本侧三角面数（合并后统计，供预算核对） */
export function countTrimTriangles(group: THREE.Object3D): number {
  let n = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    n += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  });
  return n;
}
