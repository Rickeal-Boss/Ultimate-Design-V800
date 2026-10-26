/**
 * wheelHub.ts —— V800「涡轮盘式」轮毂手写几何（R22-B，Regime H 手写件）
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 接线说明（本文件只产部件 + 材质，不接线；接线由集成层在 V800Adapter.ts      │
 * │ R22-B 区块完成，严禁在此文件外改 Adapter / spec / 工厂）                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 目标替换组件（实测场景树，run-bbox 口径）：
 *   rim-fl/fr/rl/rr        「大饼轮圈」lathe 0.6×0.27×0.6（世界 bbox 0.320×0.600×0.600）
 *   wheel-cap-fl/fr/rl/rr  「悬浮轮标」lathe 0.14×0.012×0.14
 *   轮胎 tire-* 保留不动（本部件只做轮面盘 + 中心区，胎壁/胎纹仍归现有 lathe）。
 *
 * 轮心局部系（★本文件坐标约定，接线只需给 position）：
 *   原点 = 轮心（世界 (±0.855, 0.382, ±1.715)：前轴 z=+1.715 / 后轴 z=−1.715）
 *   +Z   = 车外侧（outboard）；X-Y = 轮面平面；R_FACE = 0.300 与旧 rim 半径一致
 *   z = 0          轮心（胎宽 0.255 的中面）
 *   z = +0.1275    轮胎外端面（tire-* world x≈±0.9825 ⇒ 局部 +0.1275）
 *   z = +0.1600    旧 rim 盘面（旧 rim 宽 0.320 ⇒ 半宽 0.160），本件外唇顶同高
 *   本件 bbox：r ≤ 0.300，z ∈ [+0.1300, +0.1600]（严格落在旧 rim 包络内，不外扩）
 *
 * ★ 返回的 Group 已自带朝向：group.rotation.y = side * π/2（局部 +Z → 世界 ±X）。
 *   接线（父级为世界系，例如 wheel-fl 节点本身 rotation 为 0）：
 *     const mats = createWheelHubMaterials();          // 4 轮共享 → 只花 4 个 DC
 *     const fl = createWheelHub(1, mats);
 *     fl.position.set(0.855, 0.382, 1.715);            // 轮心世界坐标
 *     root.add(fl);
 *     const rl = createWheelHub(1, mats); rl.position.set(0.855, 0.382, -1.715);
 *     const fr = createWheelHub(-1, mats); fr.position.set(-0.855, 0.382, 1.715);
 *     const rr = createWheelHub(-1, mats); rr.position.set(-0.855, 0.382, -1.715);
 *   ⚠️ 不要复用旧 rim pivot 的 rotZ(π/2)：那只是 lathe 轴由 Y 改 X 的内部补偿，
 *      不是装配位姿。请把本 group 挂到 wheel-* 节点或 root，只设 position。
 *   ⚠️ 旧 rim 自身中心在 world z=1.727（比胎心 1.715 前移 12mm），那是旧件偏心；
 *      本件严格对胎心建，隐藏旧件后不会出现 12mm 错位。
 *
 * 独占材质（铁律 8）：4 个 id 全 r22-hub-*，不得并入全车共享批次。
 *   DC 口径：每轮 4 mesh × 4 材质 → 独占时 16 DC；4 轮共享 createWheelHubMaterials()
 *   产物时 4 DC（推荐）。本 group 必须进 batchMergeStatic 的 excludeObjects ——
 *   否则按材质实例入批后材质改名不可寻址，且合批重算法线会把镜面盘面高光磨平。
 *
 * 几何构成（每材质 1 mesh，共 4 mesh/轮）：
 *   r22-hub-bright  外唇环 + 窗带（18 个真开窗）+ 18 条机加工倒角窗框 + 主盘穹顶
 *                   + 中心凸台 + 中心镀铬环（回转体母线两段，绕窗带生成）
 *   r22-hub-dark    窗带后的暗腔整环（透过开窗看到的深腔）
 *   r22-hub-cap     黑亮圆盖（MeshPhysical clearcoat，平顶 + 收边）
 *   r22-hub-emblem  菱形徽标 canvas 贴图圆面（程序化绘制，零外部图片）
 *
 * 设计口径（参考图 C:/Users/WB/Desktop/bilibili.mp4_000030.100.jpg 实测：
 *   椭圆拟合 cx=851.4 cy=538.4 a=582 b=525.7 θ=−20.97° + 极坐标归一化，
 *   见 verify/r22/wheel/README.md 与 .img2threejs/tools/r22_wheel/measure_ellipse.py）：
 *   18 窗 / 角距 20°（上半周实测 20.1°，下半周 21.8°）
 *   窗带 0.677R–0.943R（0.203–0.283）；窗 r 0.702R–0.918R（含 9° 涡轮倾角外接）
 *   窗角半宽 6.1°（占 20° 角距 61%）；圆角 8mm
 *   外唇 0.943R–1.0R 亮面机加工（宽 0.057R ≈ 参考实测 0.06-0.09R 取下限）
 *   主盘 r<0.677R 微穹顶（中心比窗带面高 12mm = 主理人方案口径）
 *   中心：凸台 r 0.33R（Ø198）、镀铬碟窝 Ø57–104、黑盖 Ø50、徽标 Ø33
 *
 * 已知取舍（交付时已同步主理人）：
 *   1) cap-fl/fr/rl/rr（轮心滚花齿环，半径 0.148 = 0.49R，world x 0.982–0.990
 *      ⇒ 局部 z +0.127…+0.135）**无需隐藏**：本件 r<0.15 处 z ≥ 0.1476，
 *      已把该齿环整环埋入实体内部（不可见、无 z-fight）。
 *   2) 窗带是「真孔」（ShapeGeometry 挖洞）+ 后置暗腔整环，全程无 CSG 布尔。
 *   3) 窗框倒角是每窗 12 段三角带（机加工亮边），不是实体倒角 —— 屏幕尺度等价；
 *      参考图窗框的滚花/拉丝微纹理未做（需独占贴图 + 1 DC，本轮不做）。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

/* ================================================================
 * 0. 局部系常量（改这里就够了）
 * ================================================================ */

/** 轮面外半径（= 旧 rim lathe 半径 0.300） */
export const R_FACE = 0.3;
/** 回转体周向段数：28 段 ⇒ 矢高 1.9mm（屏幕 <0.6px）；窗带边界圆同点数保证无缝 */
const NSEG = 28;
/** 小件（黑盖/徽标）周向段数 */
const NSEG_SMALL = 24;
/** 窗数（参考图实测 18）/ 角距 */
export const N_WINDOWS = 18;
const WIN_PITCH = (Math.PI * 2) / N_WINDOWS;
/**
 * 窗角半宽（弧度）。
 * R33：参考图轮面开口是**大面积梯形通风窗**，不是 6° 细缝。原 6.1°×0.030R
 * 在整车侧视 8m 机位只剩一条黑线，盘面读成实心圆碟。放大到 7.6°×0.034R
 * （开口面积 +34%）；含 7.5° 涡轮倾角后的外接半径 0.2819 < 窗带外缘 0.283，
 * 仍严格落在窗带内，不破 band 边界/倒角环。
 */
const WIN_HALF_ANG = (7.6 * Math.PI) / 180;
/** 窗径向半高 / 圆角 / 涡轮倾角 */
const WIN_HALF_R = 0.034;
const WIN_CORNER = 0.009;
const WIN_TILT = (7.5 * Math.PI) / 180;
/** 窗轮廓每角弧段点数（3 点/角 = 12 边形圆角矩形） */
const WIN_ARC_PTS = 3;
/** 窗框倒角宽度 + 抬起高度 */
const BEZEL_W = 0.0035;
const BEZEL_LIFT = 0.0072;
/** 窗带环形带内外半径 / 锥面 z */
const BAND_R_IN = 0.203;
const BAND_R_OUT = 0.283;
const Z_BAND_IN = 0.1468;
const Z_BAND_OUT = 0.15;
/** 窗中线半径（= 窗带中径） */
const R_WIN_MID = (BAND_R_IN + BAND_R_OUT) / 2;
/** 外壁底（埋进轮胎）/ 唇顶 */
const Z_WALL_BOT = 0.13;
const Z_LIP_TOP = 0.16;
/** 暗腔底面 z（做成内深外浅的锥面，透窗读出腔深渐变） */
const Z_CAVITY_IN = 0.1358;
const Z_CAVITY_OUT = 0.1455;
/** 黑盖 / 徽标半径与顶面 z */
const CAP_R = 0.025;
const CAP_FLAT_R = 0.019;
const CAP_TOP_Z = 0.1496;
export const EMBLEM_R = 0.0165;
/** 材质 id（独占，铁律 8） */
export const WHEEL_HUB_MATERIAL_IDS = {
  bright: 'r22-hub-bright',
  dark: 'r22-hub-dark',
  cap: 'r22-hub-cap',
  emblem: 'r22-hub-emblem'
} as const;

/** 轮心世界坐标（供接线定位；side = sign(x)） */
export const WHEEL_HUB_CENTERS = {
  fl: { x: 0.855, y: 0.382, z: 1.715, side: 1 },
  fr: { x: -0.855, y: 0.382, z: 1.715, side: -1 },
  rl: { x: 0.855, y: 0.382, z: -1.715, side: 1 },
  rr: { x: -0.855, y: 0.382, z: -1.715, side: -1 }
} as const;

/** side = 轮心世界 x 的符号：+1 → +X 侧（fl/rl），−1 → −X 侧（fr/rr） */
export type WheelHubSide = 1 | -1;

/* ================================================================
 * 1. 对外类型
 * ================================================================ */

export interface WheelHubMaterials {
  /** 抛光银：外唇 / 窗带 / 窗框倒角 / 主盘穹顶 / 中心凸台（独占） */
  bright: THREE.MeshStandardMaterial;
  /** 暗腔（透窗可见的深腔，独占） */
  dark: THREE.MeshStandardMaterial;
  /** 黑亮圆盖（clearcoat，独占） */
  cap: THREE.MeshPhysicalMaterial;
  /** 菱形徽标（canvas 贴图，独占） */
  emblem: THREE.MeshStandardMaterial;
}

export interface WheelHubResult {
  /** 轮心局部系原点构建，已含 rotation.y = side*π/2（接线只需再给 position） */
  group: THREE.Group;
  materials: WheelHubMaterials;
  /** 单轮三角形总数 */
  triangleCount: number;
}

/* ================================================================
 * 2. 几何辅助
 * ================================================================ */

/** 母线点 [r 半径, z 轴向] */
type ProfilePoint = readonly [number, number];

/**
 * 回转体。母线必须按「由外下方向内上方」遍历（顶点法线朝外的前提）。
 * 顶点法线 = 相邻段法线的平均（平滑着色；本件禁 flatShading）。
 * 输出非索引几何（position/normal/uv 齐备，可与 ShapeGeometry 混拼 mergeSafe）。
 */
function revolve(profile: readonly ProfilePoint[], nseg: number): THREE.BufferGeometry {
  const segN: Array<[number, number]> = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [ar, az] = profile[i];
    const [br, bz] = profile[i + 1];
    const dr = br - ar;
    const dz = bz - az;
    const len = Math.hypot(dr, dz) || 1;
    // 外法线（母线由外向内遍历时）：N = (dz, −dr)
    segN.push([dz / len, -dr / len]);
  }
  const ptN: Array<[number, number]> = profile.map((_, i) => {
    const a = segN[Math.max(0, i - 1)];
    const b = segN[Math.min(segN.length - 1, i)];
    const nr = a[0] + b[0];
    const nz = a[1] + b[1];
    const len = Math.hypot(nr, nz) || 1;
    return [nr / len, nz / len];
  });

  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const emit = (ri: number, ti: number): void => {
    const r = profile[ri][0];
    const z = profile[ri][1];
    const n = ptN[ri];
    const c = Math.cos(ti);
    const s = Math.sin(ti);
    pos.push(r * c, r * s, z);
    nor.push(n[0] * c, n[0] * s, n[1]);
    uv.push(ti / (Math.PI * 2), ri / (profile.length - 1));
  };
  for (let s = 0; s < nseg; s++) {
    const t0 = (s / nseg) * Math.PI * 2;
    const t1 = ((s + 1) / nseg) * Math.PI * 2;
    for (let i = 0; i < profile.length - 1; i++) {
      // 支点（r=0）处的段退化为一圈扇形三角，不出退化三角
      if (profile[i][0] === 0) {
        emit(i, 0);
        emit(i + 1, t1);
        emit(i + 1, t0);
        continue;
      }
      if (profile[i + 1][0] === 0) {
        emit(i, t0);
        emit(i, t1);
        emit(i + 1, 0);
        continue;
      }
      // 从 +Z（车外侧）看逆时针：A(i,t0) → D(i,t1) → C(i+1,t1) → B(i+1,t0)
      emit(i, t0); // A
      emit(i, t1); // D
      emit(i + 1, t1); // C
      emit(i, t0); // A
      emit(i + 1, t1); // C
      emit(i + 1, t0); // B
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** 窗带面 z：r → z 线性（内低外高，微锥） */
function bandZ(r: number): number {
  const t = (r - BAND_R_IN) / (BAND_R_OUT - BAND_R_IN);
  return Z_BAND_IN + (Z_BAND_OUT - Z_BAND_IN) * t;
}

/** 正多边形圆周（回转体与窗带边界严格同点，避免裂缝）。
 *  ⚠️ 只输出 nseg 个点、不重复首点为末点：three 的 removeDupEndPts 用 === 比较，
 *  而 cos(2π)/sin(2π) 的浮点尾数会让「重复点」逃过判重 → earcut 出退化三角。 */
function polygonPath(
  path: THREE.Shape | THREE.Path,
  r: number,
  nseg: number,
  clockwise: boolean
): void {
  for (let i = 0; i < nseg; i++) {
    const k = clockwise ? nseg - 1 - i : i;
    const t = (k / nseg) * Math.PI * 2;
    const x = k === 0 ? r : r * Math.cos(t);
    const y = k === 0 ? 0 : r * Math.sin(t);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
}

/**
 * 单窗轮廓（圆角矩形，CCW），返回「(dr, ds) 平面 + 涡轮倾角」后的点：
 *   dr = 径向偏移（m），ds = 切向弧长偏移（m）
 */
function windowOutline(expand = 0): Array<[number, number]> {
  const hr = WIN_HALF_R + expand;
  const hs = R_WIN_MID * Math.tan(WIN_HALF_ANG) + expand;
  const rc = Math.max(0.0015, WIN_CORNER + expand);
  const corners: Array<[number, number, number]> = [
    [hr - rc, hs - rc, 0], // +dr,+ds 角
    [-hr + rc, hs - rc, Math.PI / 2], // −dr,+ds
    [-hr + rc, -hs + rc, Math.PI], // −dr,−ds
    [hr - rc, -hs + rc, (Math.PI * 3) / 2] // +dr,−ds
  ];
  const out: Array<[number, number]> = [];
  const ct = Math.cos(WIN_TILT);
  const st = Math.sin(WIN_TILT);
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k < WIN_ARC_PTS; k++) {
      const a = a0 + (k * Math.PI) / (2 * (WIN_ARC_PTS - 1));
      const dr = cx + rc * Math.cos(a);
      const ds = cy + rc * Math.sin(a);
      // 涡轮倾角：绕窗心旋转 WIN_TILT
      out.push([dr * ct - ds * st, dr * st + ds * ct]);
    }
  }
  return out;
}

/** (dr,ds)@窗位角 → 局部 X-Y（极坐标映射：切向弧长 / 当前半径 = 角偏移） */
function toXY(dr: number, ds: number, ang: number): [number, number] {
  const r = R_WIN_MID + dr;
  const th = ang + ds / r;
  return [r * Math.cos(th), r * Math.sin(th)];
}

/** 单窗几何自检数据（QA / 接线核对用，纯函数） */
export interface WheelWindowInfo {
  /** 序号 0..17 */
  index: number;
  /** 窗中心角（度，局部 +X 起逆时针） */
  angleDeg: number;
  /** 窗内缘 / 外缘半径（含涡轮倾角后的外接半径） */
  rIn: number;
  rOut: number;
  rMid: number;
  /** 角距（度）= 360/N */
  pitchDeg: number;
  /** 窗中心半径处的角半宽（度） */
  halfAngleDeg: number;
  tiltDeg: number;
  cornerR: number;
  /** 窗框倒角环外接半径范围（必须在窗带 0.203–0.283 内） */
  bezelInnerR: number;
  bezelOuterR: number;
}

/** 列出 18 个窗的实测几何（含倾角后的 r 外接范围），供 QA 断言与接线核对 */
export function listWheelWindows(): WheelWindowInfo[] {
  const outline = windowOutline(0);
  const rs = outline.map(([dr]) => R_WIN_MID + dr);
  const rIn = Math.min(...rs);
  const rOut = Math.max(...rs);
  const bOutline = windowOutline(BEZEL_W);
  const brs = bOutline.map(([dr]) => R_WIN_MID + dr);
  const out: WheelWindowInfo[] = [];
  for (let w = 0; w < N_WINDOWS; w++) {
    out.push({
      index: w,
      angleDeg: (w * WIN_PITCH * 180) / Math.PI,
      rIn,
      rOut,
      rMid: (rIn + rOut) / 2,
      pitchDeg: (WIN_PITCH * 180) / Math.PI,
      halfAngleDeg: (WIN_HALF_ANG * 180) / Math.PI,
      tiltDeg: (WIN_TILT * 180) / Math.PI,
      cornerR: WIN_CORNER,
      bezelInnerR: Math.min(...brs),
      bezelOuterR: Math.max(...brs)
    });
  }
  return out;
}

/** 窗带 Shape：外圆 CCW + 内圆 CW + 18 个窗孔 CW */
function buildBandShape(): THREE.Shape {
  const shape = new THREE.Shape();
  polygonPath(shape, BAND_R_OUT, NSEG, false);
  const inner = new THREE.Path();
  polygonPath(inner, BAND_R_IN, NSEG, true);
  shape.holes.push(inner);
  const outline = windowOutline(0);
  for (let w = 0; w < N_WINDOWS; w++) {
    const ang = w * WIN_PITCH;
    const hole = new THREE.Path();
    // 顺时针绕序（与外轮廓 CCW 相反，earcut 才认作孔）
    for (let i = outline.length - 1; i >= 0; i--) {
      const [x, y] = toXY(outline[i][0], outline[i][1], ang);
      if (i === outline.length - 1) hole.moveTo(x, y);
      else hole.lineTo(x, y);
    }
    shape.holes.push(hole);
  }
  return shape;
}

/** 窗带几何（真开窗），顶点 z 按半径抬成微锥 */
export function createWheelHubBandGeometry(): THREE.BufferGeometry {
  const geo = new THREE.ShapeGeometry(buildBandShape(), 1);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3 + 2] = bandZ(Math.hypot(arr[i * 3], arr[i * 3 + 1]));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

/** 窗框倒角环（每窗 1 圈三角带）：内缘贴窗带面，外缘抬起 BEZEL_LIFT */
function buildBezels(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number
  ): void => {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    if (nz < 0) {
      // 倒角面统一朝车外侧（+Z）
      pos.push(ax, ay, az, cx, cy, cz, bx, by, bz);
      nx = -nx;
      ny = -ny;
      nz = -nz;
    } else {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
    for (let k = 0; k < 3; k++) nor.push(nx, ny, nz);
    uv.push(0, 0, 1, 0, 1, 1);
  };
  const innerPts = windowOutline(0);
  const outerPts = windowOutline(BEZEL_W);
  for (let w = 0; w < N_WINDOWS; w++) {
    const ang = w * WIN_PITCH;
    const n = innerPts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [ix0, iy0] = toXY(innerPts[i][0], innerPts[i][1], ang);
      const [ix1, iy1] = toXY(innerPts[j][0], innerPts[j][1], ang);
      const [ox0, oy0] = toXY(outerPts[i][0], outerPts[i][1], ang);
      const [ox1, oy1] = toXY(outerPts[j][0], outerPts[j][1], ang);
      const iz0 = bandZ(Math.hypot(ix0, iy0)) + 0.0007;
      const iz1 = bandZ(Math.hypot(ix1, iy1)) + 0.0007;
      const oz0 = bandZ(Math.hypot(ox0, oy0)) + BEZEL_LIFT;
      const oz1 = bandZ(Math.hypot(ox1, oy1)) + BEZEL_LIFT;
      tri(ix0, iy0, iz0, ix1, iy1, iz1, ox1, oy1, oz1);
      tri(ix0, iy0, iz0, ox1, oy1, oz1, ox0, oy0, oz0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** 暗腔整环（透窗可见的深腔），内深外浅锥面 → 窗内读出腔深渐变 */
function buildCavity(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  polygonPath(shape, BAND_R_OUT + 0.001, NSEG, false);
  const inner = new THREE.Path();
  polygonPath(inner, BAND_R_IN - 0.001, NSEG, true);
  shape.holes.push(inner);
  const geo = new THREE.ShapeGeometry(shape, 1);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(arr[i * 3], arr[i * 3 + 1]);
    const t = (r - BAND_R_IN) / (BAND_R_OUT - BAND_R_IN);
    arr[i * 3 + 2] = Z_CAVITY_IN + (Z_CAVITY_OUT - Z_CAVITY_IN) * t;
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

/* ================================================================
 * 3. 徽标 canvas 贴图（程序化，零外部图片）
 * ================================================================ */

/**
 * MAEXTRO 菱形徽标：细线框「八面体投影」+ 中部 MAEXTRO 铭牌。
 * UV 约定：徽标圆面的外接正方形 == 整张 canvas（圆内切于方），
 * 故图形宽度取 0.50S ⇒ 实际宽 0.50*2*EMBLEM_R ≈ 16.5mm、高 ≈ 28mm（参考实测比例）。
 * node（无真 DOM）环境返回 null —— 材质降级为无图亮银，几何校验不受影响。
 */
export function makeWheelEmblemTexture(size = 256): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const S = size;
  const cx = S / 2;
  const W = S * 0.25; // 六边形半宽（宽高比 ≈1.75，贴参考竖向菱形）
  const D = S * 0.15; // 内菱形半宽
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = '#f2f6fa';
  ctx.lineCap = 'round';

  // 外轮廓：竖六边形（上尖 / 下尖 + 直腰）
  const hex: Array<[number, number]> = [
    [cx, S * 0.075],
    [cx + W, S * 0.3],
    [cx + W, S * 0.7],
    [cx, S * 0.925],
    [cx - W, S * 0.7],
    [cx - W, S * 0.3]
  ];
  ctx.lineWidth = S * 0.014;
  ctx.beginPath();
  for (let i = 0; i < hex.length; i++) {
    if (i === 0) ctx.moveTo(hex[i][0], hex[i][1]);
    else ctx.lineTo(hex[i][0], hex[i][1]);
  }
  ctx.closePath();
  ctx.stroke();

  // 内层菱形（八面体横截面）
  ctx.lineWidth = S * 0.01;
  ctx.beginPath();
  ctx.moveTo(cx, S * 0.185);
  ctx.lineTo(cx + D, S * 0.5);
  ctx.lineTo(cx, S * 0.815);
  ctx.lineTo(cx - D, S * 0.5);
  ctx.closePath();
  ctx.stroke();

  // 晶格斜线
  ctx.beginPath();
  ctx.moveTo(cx, S * 0.185);
  ctx.lineTo(cx - W, S * 0.3);
  ctx.moveTo(cx, S * 0.185);
  ctx.lineTo(cx + W, S * 0.3);
  ctx.moveTo(cx, S * 0.815);
  ctx.lineTo(cx - W, S * 0.7);
  ctx.moveTo(cx, S * 0.815);
  ctx.lineTo(cx + W, S * 0.7);
  ctx.moveTo(cx - W, S * 0.3);
  ctx.lineTo(cx - D, S * 0.5);
  ctx.lineTo(cx - W, S * 0.7);
  ctx.moveTo(cx + W, S * 0.3);
  ctx.lineTo(cx + D, S * 0.5);
  ctx.lineTo(cx + W, S * 0.7);
  ctx.stroke();

  // 中部铭牌 + MAEXTRO
  ctx.lineWidth = S * 0.009;
  ctx.beginPath();
  ctx.moveTo(cx - D, S * 0.44);
  ctx.lineTo(cx + D, S * 0.44);
  ctx.moveTo(cx - D, S * 0.56);
  ctx.lineTo(cx + D, S * 0.56);
  ctx.stroke();
  ctx.fillStyle = '#eaf0f6';
  ctx.font = `${Math.round(S * 0.062)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MAEXTRO', cx, S * 0.5);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ================================================================
 * 4. 独占材质工厂
 * ================================================================ */

export function createWheelHubMaterials(emblemTex?: THREE.Texture | null): WheelHubMaterials {
  const mk = (
    id: string,
    params: THREE.MeshStandardMaterialParameters
  ): THREE.MeshStandardMaterial => {
    // R30-C1：revolve 封闭实体默认 FrontSide；单面件（emblem 徽标圆面）显式保留 DoubleSide
    const m = new THREE.MeshStandardMaterial({ side: THREE.FrontSide, ...params });
    m.userData.sculptMaterial = { id };
    m.name = id;
    return m;
  };
  const tex = emblemTex === undefined ? makeWheelEmblemTexture() : emblemTex;
  const cap = new THREE.MeshPhysicalMaterial({
    // R30-C1：cap 是 revolve 封闭实体（平顶+收边黑亮圆盖）→ FrontSide
    side: THREE.FrontSide,
    color: 0x090a0c,
    metalness: 0.82,
    roughness: 0.1,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 0.9
  });
  cap.userData.sculptMaterial = { id: WHEEL_HUB_MATERIAL_IDS.cap };
  cap.name = WHEEL_HUB_MATERIAL_IDS.cap;

  return {
    // 抛光银：与全车 wheel-alloy（#DADDDF / rough 0.28 / metal 0.95 / envInt 0.55）同族，
    // 盘面要求更镜（参考图为镜面抛光），故 rough 0.16 / envInt 0.75；
    // envInt 不拉满 —— R8 教训：镜面轮圈把 RoomEnvironment 暖光镜像读作锈斑。
    bright: mk(WHEEL_HUB_MATERIAL_IDS.bright, {
      color: 0xdfe3e7,
      metalness: 0.96,
      roughness: 0.16,
      envMapIntensity: 0.75
    }),
    dark: mk(WHEEL_HUB_MATERIAL_IDS.dark, {
      color: 0x0a0c0f,
      metalness: 0.45,
      roughness: 0.48
    }),
    cap,
    emblem: tex
      ? mk(WHEEL_HUB_MATERIAL_IDS.emblem, {
          // 徽标圆面是单面 ShapeGeometry（浮在盖顶 0.3mm，UV 归一到 canvas）——
          // 保留 DoubleSide：轮子高可见度主视觉件，防内侧/掠射机位被剔（alphaTest 裁掉
          // 透明底后实际开销≈一个圆面）
          side: THREE.DoubleSide,
          color: 0xffffff,
          map: tex,
          emissive: 0xffffff,
          emissiveMap: tex,
          emissiveIntensity: 0.5,
          metalness: 0.9,
          roughness: 0.22,
          alphaTest: 0.35,
          transparent: false
        })
      : mk(WHEEL_HUB_MATERIAL_IDS.emblem, {
          // 无图降级（node shim / 无 DOM）
          side: THREE.DoubleSide,
          color: 0xcfd6de,
          emissive: 0x8f9aa6,
          emissiveIntensity: 0.35,
          metalness: 0.9,
          roughness: 0.25
        })
  };
}

/* ================================================================
 * 5. 主构造
 * ================================================================ */

export function createWheelHub(side: WheelHubSide = 1, materials?: WheelHubMaterials): THREE.Group {
  const mats = materials ?? createWheelHubMaterials();
  const group = new THREE.Group();
  group.name = side > 0 ? 'r22-wheel-hub-xp' : 'r22-wheel-hub-xn';
  // 局部 +Z（车外侧）→ 世界 +X（side=+1）/ −X（side=−1）
  group.rotation.y = (side * Math.PI) / 2;

  /* ---- 5.1 抛光银：外唇环（母线由外下 → 内上）---- */
  const lipProfile: ProfilePoint[] = [
    [R_FACE, Z_WALL_BOT], // 外壁底（埋进轮胎）
    [R_FACE, 0.142], // 外壁顶
    [0.2965, 0.1525], // 外倒角
    [0.2885, Z_LIP_TOP], // 唇顶（最亮机加工环，宽 0.06R ≈ 参考实测）
    [BAND_R_OUT, Z_BAND_OUT] // 45° 落回窗带外缘
  ];

  /* ---- 5.2 抛光银：主盘穹顶 + 中心凸台 + 镀铬环 + 中心碟窝 ----
   * z 口径：窗带内缘 0.1468 → 中心峰值 0.1588（+12mm，与主理人方案一致），
   * 全程 ≤ 唇顶 0.1600 = 旧 rim 盘面，不外扩出旧包络。 */
  const discProfile: ProfilePoint[] = [
    [BAND_R_IN, Z_BAND_IN], // 窗带内缘（= bandZ(BAND_R_IN)）
    [0.17, 0.15], // 穹顶起坡
    [0.135, 0.1538],
    [0.099, 0.157], // 凸台外缘（0.33R）
    [0.078, 0.1586], // 凸台台面 / 穹顶峰值
    [0.052, 0.1548], // 落进中心碟窝
    [0.038, 0.1508], // 镀铬环面
    [CAP_R, 0.147] // 黑盖外缘（垂直收口）
  ];

  const brightGeo = mergeSafe([
    revolve(lipProfile, NSEG),
    revolve(discProfile, NSEG),
    createWheelHubBandGeometry(),
    buildBezels()
  ]);

  /* ---- 5.3 暗腔整环 ---- */
  const darkGeo = buildCavity();

  /* ---- 5.4 黑亮圆盖（平顶 + 收边，顶面承载徽标贴图）---- */
  const capProfile: ProfilePoint[] = [
    [0, CAP_TOP_Z],
    [CAP_FLAT_R, CAP_TOP_Z],
    [0.023, 0.1489],
    [CAP_R, 0.1466] // 略低于碟窝收口 (0.1470)，嵌入不留缝
  ];
  const capGeo = revolve(capProfile, NSEG_SMALL);

  /* ---- 5.5 徽标圆面（UV 归一到 canvas，浮在盖顶 0.3mm）---- */
  const emblemGeo = (() => {
    const s = new THREE.Shape();
    polygonPath(s, EMBLEM_R, NSEG_SMALL, false);
    const g = new THREE.ShapeGeometry(s, 1);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      pos.setZ(i, CAP_TOP_Z + 0.0003);
      uv.setXY(i, 0.5 + x / (2 * EMBLEM_R), 0.5 + y / (2 * EMBLEM_R));
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  })();

  /* ---- 5.6 装配：每材质 1 mesh ---- */
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): void => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(brightGeo, mats.bright, WHEEL_HUB_MATERIAL_IDS.bright);
  add(darkGeo, mats.dark, WHEEL_HUB_MATERIAL_IDS.dark);
  add(capGeo, mats.cap, WHEEL_HUB_MATERIAL_IDS.cap);
  add(emblemGeo, mats.emblem, WHEEL_HUB_MATERIAL_IDS.emblem);

  /* ---- 5.7 统计 ---- */
  let triangleCount = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    triangleCount += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  });
  group.updateMatrixWorld(true);
  group.userData.r22WheelHub = {
    side,
    radius: R_FACE,
    windows: N_WINDOWS,
    triangleCount,
    materialIds: WHEEL_HUB_MATERIAL_IDS
  };
  return group;
}

/** 需要 materials / tri 数时用它（等价 createWheelHub + 回收统计） */
export function createWheelHubResult(
  side: WheelHubSide = 1,
  materials?: WheelHubMaterials
): WheelHubResult {
  const mats = materials ?? createWheelHubMaterials();
  const group = createWheelHub(side, mats);
  const info = group.userData.r22WheelHub as { triangleCount: number };
  return { group, materials: mats, triangleCount: info.triangleCount };
}
