/**
 * tailLamp.ts —— V800 尾灯「鹰形 LED 竖灯」手写几何（R21-B）
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 接线说明（本文件只产部件 + 材质，不接线；接线由集成层在                      │
 * │ V800Adapter.ts 的 R21-B 区块完成，严禁在此文件外改 Adapter / spec / 工厂） │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 目标替换组件（实测场景树，run-bbox 口径；每侧 7 件，共 14 件）：
 *   宫灯尾灯左__pivot（spec id=taillamp-l，pos [0.92,0.83,-2.839] rotY π）
 *   ├── taillamp-l          宫灯尾灯壳   housing-dark  0.170×0.460×0.049
 *   ├── taillamp-bar-top-l  尾灯上横杠   lamp-red
 *   ├── taillamp-bar-bottom-l 尾灯下横杠 lamp-red
 *   ├── lantern-core-l      第二道红带   lamp-red
 *   ├── lantern-bezel-l     拉丝银框     chrome        0.152×0.442
 *   ├── lantern-emitter-l   红色灯带场   housing-dark  0.140×0.430
 *   └── lantern-signature-l 琥珀点阵屏   lamp-gold     0.070×0.100
 *   （右侧 -r 完全镜像，pivot pos [-0.92,0.83,-2.839]）
 *   旧件是「宫灯」横杠叠层，与真车（C1 特写：镀铬包边 + 上 3 红刃 + 中部金色鹰形
 *   点阵屏 + 下 2 红刃）不符，故整组手写替换。
 *
 * 对齐锚点（★与 headLamp 相反的 z 朝向约定，接线时勿套用 R21-C 的 FRONT_Z）：
 *   x ∈ [-0.085, +0.085]   宽 0.17（与实测 world bbox 逐位一致）
 *   y ∈ [-0.23,  +0.23 ]   高 0.46（同上）
 *   z = 0                  ★外露可见面（preview 世界车尾 = +Z，pivot 世界 z=+2.839）
 *   z ∈ [0, +0.049]        旧壳体向车内（world zmin 方向 +2.888）
 *   ⚠️ R21 补验更正（主理人，探针 verify/r21/lamp-probe/lamp_probe.json 实证）：
 *   本文件初版注释写的「taillamp pivot 自带 rotY(π)」与真实场景不符——场景中 pivot
 *   **无旋转**（初版 QA 也按 rotY(π) 建模，两错相撞曾互相抵消）。接线层因此套一层
 *   rotY(π) 外层容器（V800Adapter R21-B 区块），本文件局部约定不变：
 *     镀铬包边   z ∈ [-0.028, -0.012]（经外层 rotY(π) 后外凸于尾门面）
 *     红色灯刃   z ∈ [-0.0225, -0.0125]（比包边 front 低 3.5mm，读成内嵌）
 *     鹰形点阵屏 z = -0.0125（背板 front -0.013 前 0.5mm，无 z-fight；法线经外层转 π 朝车尾）
 *     深色背板   z ∈ [-0.013, +0.022]（嵌进旧壳 0..0.049 包络内）
 *   世界 y：pivot y=0.83 ⇒ 灯顶 1.06 / 灯底 0.60；顶部铬条（y 1.08..1.15）、
 *   后保反光条（y 0.4）均无重叠，实测过。
 *
 * 接线步骤（必须在 batchMergeStatic 之前，红线与 R20 尾门同律）：
 *   1) import { createTailLamp, createTailLampMaterials, TAIL_LAMP_STANDBY } from './parts/tailLamp';
 *   2) 找 pivot：model.traverse 中 userData.sculptComponent.id === 'taillamp-l' / 'taillamp-r'
 *      且 children.length > 0 的节点（pivot 与壳 mesh 同 id，凭「有子节点」消歧）。
 *   3) 隐旧：把该 pivot 的全部现有 children 逐个 visible=false（7 件/侧全部在内）。
 *      ★ 不能把新 group 挂在 visible=false 的节点下（three 不渲染隐藏子树），
 *        所以新 group 必须挂 pivot 本体。batchMerge 对 visible=false 的子树自动跳过
 *        （batchMerge.ts L194），旧件不会进批次、新件不受影响。
 *   4) 挂新：pivot.add(wrap)（wrap = 外层 Group，rotation.y = π，内含
 *      createTailLamp({side,materials}).group —— 见头部「R21 补验更正」）。
 *      左右必须共用同一份 createTailLampMaterials() 实例（各材质 1 个 DC）。
 *   5) 防合批吞并（红线）：把两个 pivot 加进 batchMergeStatic 的 excludeObjects。
 *      本部件 4 个材质 id 全为 r21-tail-lamp-*（独占），若被按 id 并进全车批次，
 *      batch 复制材质实例会导致下面第 6 步的刹车联动改不到实际渲染材质。
 *   6) 刹车灯联动（替换旧 tailMat/goldMat 对尾灯的作用，update() 内）：
 *        redMat.emissiveIntensity  = TAIL_LAMP_STANDBY.red  + brakeLevel + snapGain;
 *        goldMat.emissiveIntensity = TAIL_LAMP_STANDBY.gold + (brakeLevel + snapGain)
 *                                    * TAIL_LAMP_GOLD_BRAKE_RATIO;   // 0.75，同旧 goldMat 口径
 *      材质引用在第 4 步的返回值 materials 里拿（红=r21-tail-lamp-red、金=r21-tail-lamp-gold）。
 *      旧链路不受影响：lamp-red（后保反光条）仍走 tailMat；housing-dark 的红带
 *      emissiveMap 与 remapUVToRegion 只作用于已隐藏的旧件，可原样保留。
 *   7) 独占材质克隆警告：r21-tail-lamp-* 四个 id 不得并入共享批次，也不得把
 *      materials.* 实例再借给其他部件 —— 每帧 emissiveIntensity 直写是全组联动，
 *      借用会把别处灯件一起拉亮。
 *
 * 几何约定（与 project 铁律一致）：
 *   · profile / 轮廓一律 CCW（shoelace > 0），ExtrudeGeometry 前向法线朝外；
 *   · 挤出沿 +z（0→depth），本文件各层用 translate 落位（见上表）；
 *   · 右侧镜像用 group.scale.x = -1（纯 −x 镜像，非旋转）；材质统一 DoubleSide
 *     兜住镜像绕序翻转（R21-C 同律）；
 *   · ≤ 2.5k tri/侧（实测 ≈ 0.9k，见 .qa/r21_taillamp.mjs 输出）。
 *
 * 鹰形点阵屏（tri 预算优先贴图方案）：
 *   单面 PlaneGeometry + 程序 canvas 点阵贴图（零外部图片）。点阵生成核心
 *   paintEaglePanel() 是纯函数（painter 注入）：浏览器走 CanvasRenderingContext2D，
 *   node QA 走软件光栅化，同一份代码两处验证。鹰形轮廓用解析遮罩（羽/身/首/尾
 *   旋转椭圆并集），20×32 点阵采样。待机低亮度由 TAIL_LAMP_STANDBY.gold 控制。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

/* ================================================================
 * 0. 局部系常量（锚点口径见头部注释；改灯罩尺寸只动这里）
 * ================================================================ */

/** 灯罩总宽（实测 taillamp-l world bbox size.x） */
export const LAMP_W = 0.17;
/** 灯罩总高（实测 size.y） */
export const LAMP_H = 0.46;
/** 外露面局部 z（= pivot 世界 z -2.839 平面） */
export const FACE_Z = 0;
/** 镀铬包边 front 相对 FACE_Z 的外凸量（任务书 2–3cm 视觉凸出取中） */
export const PROTRUDE = 0.024;
/** 包边挤出厚（z -0.024..-0.012，背面嵌进背板 1mm 防共面闪烁；无 bevel 保 bbox 契约） */
export const BEZEL_DEPTH = 0.012;
/** 背板 front / back（嵌进旧壳 0..0.049 包络） */
export const HOUSING_FRONT = -0.013;
export const HOUSING_DEPTH = 0.035;

/** 镀铬包边框宽 ≈ 罩宽 5%（任务书口径）→ 内开孔 0.153×0.443 */
export const BEZEL_FRAME_W = 0.0085;
/** 灯刃几何（C1 实测：顶部 3 片 + 底部 2 片，高≈罩高 5–6%，微斜切） */
export const TAIL_LAMP_BLADES = {
  /** 局部 y 中心（罩内顶部区 ≈罩高 22%：y 0.129..0.23） */
  top: [0.135, 0.172, 0.207],
  /** 底部区 ≈罩高 20%（y -0.23..-0.138） */
  bottom: [-0.146, -0.186],
  width: 0.126,
  height: 0.024,
  radius: 0.01,
  /** 微斜切（rad，约 0.8°；镜像后左右自然反向） */
  slantRad: -0.014,
  depth: 0.008,
  /** front z（比包边 front 低 3.5mm 的内嵌位） */
  z: -0.0215
} as const;
/** 鹰形点阵屏（中部 ≈罩高 50% 区域） */
export const EAGLE_PANEL = {
  w: 0.136,
  h: 0.22,
  y: -0.004,
  z: -0.0125,
  cols: 20,
  rows: 32
} as const;

/* ================================================================
 * 1. 对外类型 / 联动常量
 * ================================================================ */

export interface TailLampMaterials {
  /** 深色背板/暗场（独占；勿用共享 housing-dark —— 适配层给它挂了红带 emissiveMap） */
  housing: THREE.MeshStandardMaterial;
  /** 镀铬包边（独占，质感对齐共享 chrome） */
  chrome: THREE.MeshStandardMaterial;
  /** 红色灯刃（emissive，独占；刹车联动目标） */
  red: THREE.MeshStandardMaterial;
  /** 鹰形点阵屏（emissive + canvas 贴图，独占；刹车联动目标） */
  gold: THREE.MeshStandardMaterial;
}

export interface TailLampOptions {
  /** 'right' 用 group.scale.x = -1 做 −x 镜像（非旋转） */
  side?: 'left' | 'right';
  /** 复用外部材质实例（接线时左右必须共用同一份） */
  materials?: TailLampMaterials;
  /** 鹰形点阵贴图；缺省自动 canvas 生成（node 无 DOM 时自动降级无图材质） */
  eagleTexture?: THREE.Texture | null;
}

export interface TailLampResult {
  /** 在 taillamp pivot 局部系原点构建的 Group（右侧已含 scale.x=-1 镜像） */
  group: THREE.Group;
  /** 本部件用到的 4 个独占材质 */
  materials: TailLampMaterials;
  /** 本侧三角形总数 */
  triangleCount: number;
}

/** 独占材质 id（batchMerge / 落地审查寻址用） */
export const TAIL_LAMP_MATERIAL_IDS = {
  housing: 'r21-tail-lamp-housing',
  chrome: 'r21-tail-lamp-chrome',
  red: 'r21-tail-lamp-red',
  gold: 'r21-tail-lamp-gold'
} as const;

/** 待机（低亮度）发光强度；刹车联动在此之上叠加（见头部接线第 6 步）。
 *  R23 look-dev：鹰形点阵屏待机偏暗 → gold 由 0.55 提升至 0.80（≈1.45×），
 *  点阵仍按 emissiveMap 同源缩放保持可读、不糊成亮斑；该常量同时驱动材质初值
 *  (L396) 与 V800Adapter 刹车联动 standby 基值 (L4218)，一处提升两路受益。 */
export const TAIL_LAMP_STANDBY = { red: 0.5, gold: 0.80 } as const;
/** 金屏刹车联动比例（与 V800Adapter GOLD_BRAKE_RATIO 同口径） */
export const TAIL_LAMP_GOLD_BRAKE_RATIO = 0.75;

/** 本部件整组替换的旧组件 id（接线遍历/排除名单用） */
export const TAIL_LAMP_REPLACE_IDS = [
  'taillamp-l', 'taillamp-r',
  'taillamp-bar-top-l', 'taillamp-bar-bottom-l',
  'taillamp-bar-top-r', 'taillamp-bar-bottom-r',
  'lantern-core-l', 'lantern-bezel-l', 'lantern-emitter-l', 'lantern-signature-l',
  'lantern-core-r', 'lantern-bezel-r', 'lantern-emitter-r', 'lantern-signature-r'
] as const;

/* ================================================================
 * 2. 形状 / 挤出辅助（全部 CCW，同 R21-C headLamp）
 * ================================================================ */

/** 圆角矩形轮廓（CCW，中心在原点） */
function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const hw = w / 2;
  const hh = h / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);
  s.lineTo(hw, hh - r);
  s.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);
  s.lineTo(-hw + r, hh);
  s.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-hw, -hh + r);
  s.absarc(-hw + r, -hh + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** 圆角矩形「框」（外 CCW + 内孔反向），镀铬包边用 */
function roundedRectFrameShape(
  w: number, h: number, r: number,
  iw: number, ih: number, ir: number
): THREE.Shape {
  const outer = roundedRectShape(w, h, r);
  const hole = new THREE.Path();
  const hw = iw / 2;
  const hh = ih / 2;
  hole.moveTo(-hw + ir, -hh);
  hole.lineTo(hw - ir, -hh);
  hole.absarc(hw - ir, -hh + ir, ir, -Math.PI / 2, 0, true);
  hole.lineTo(hw, hh - ir);
  hole.absarc(hw - ir, hh - ir, ir, 0, Math.PI / 2, true);
  hole.lineTo(-hw + ir, hh);
  hole.absarc(-hw + ir, hh - ir, ir, Math.PI / 2, Math.PI, true);
  hole.lineTo(-hw, -hh + ir);
  hole.absarc(-hw + ir, -hh + ir, ir, Math.PI, Math.PI * 1.5, true);
  outer.holes.push(hole);
  return outer;
}

/** 挤出 0→depth；bevel>0 时两端各外扩 bevel（z 与 xy 同时） */
function extrude(shape: THREE.Shape, depth: number, bevel: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 6
  });
  g.computeBoundingBox();
  return g;
}

function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  g.computeBoundingBox();
  return g;
}

/* ================================================================
 * 3. 鹰形点阵：解析遮罩 + painter 注入（浏览器 canvas / node 软 raster 共用）
 * ================================================================ */

/** 点阵绘制抽象：fill 铺底，circle 画点。坐标均为像素。 */
export interface EaglePanelPainter {
  fill(w: number, h: number, color: string): void;
  circle(x: number, y: number, r: number, color: string): void;
}

interface Pt {
  x: number;
  y: number;
}

/** 点 (p) 是否在「中心 c、轴向 dir、半长 a、半宽 b」的旋转椭圆内（uv 系，v 向下） */
function inRotEllipse(p: Pt, c: Pt, dir: Pt, a: number, b: number): boolean {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const along = dx * dir.x + dy * dir.y;
  const across = dx * -dir.y + dy * dir.x;
  return (along / a) * (along / a) + (across / b) * (across / b) <= 1;
}

/** 点是否在三角形内（叉积同侧法） */
function inTri(p: Pt, t0: Pt, t1: Pt, t2: Pt): boolean {
  const s1 = (t1.x - t0.x) * (p.y - t0.y) - (t1.y - t0.y) * (p.x - t0.x);
  const s2 = (t2.x - t1.x) * (p.y - t1.y) - (t2.y - t1.y) * (p.x - t1.x);
  const s3 = (t0.x - t2.x) * (p.y - t2.y) - (t0.y - t2.y) * (p.x - t2.x);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

/**
 * 鹰形解析遮罩。uv ∈ [0,1]²（v 向下）；返回 0=熄灭 / 1=常亮点 / 2=高亮羽尖。
 * 布局：头部在 (0.55,0.30)，5 片飞羽从肩部 (0.525,0.42) 向画布**左侧**上扬
 * （画布左 = 部件局部 +x = 世界车头向 —— 左灯上鹰首朝车头、翼展向车中，
 * 右灯经 −x 镜像自然对称），躯干竖直椭圆 + 3 片尾羽向下。
 */
export function eagleMask(u: number, v: number): 0 | 1 | 2 {
  const p: Pt = { x: u, y: v };
  // 头
  const headC: Pt = { x: 0.55, y: 0.3 };
  const dxh = p.x - headC.x;
  const dyh = p.y - headC.y;
  if (dxh * dxh + dyh * dyh <= 0.045 * 0.045) return 1;
  // 喙（朝画布左）
  if (inTri(p, { x: 0.508, y: 0.292 }, { x: 0.452, y: 0.312 }, { x: 0.512, y: 0.332 })) return 1;
  // 躯干（竖直长椭圆）
  if (inRotEllipse(p, { x: 0.555, y: 0.545 }, { x: 0, y: 1 }, 0.17, 0.042)) return 1;
  // 尾羽 3 片（向下扇开）
  for (const aDeg of [258, 270, 282]) {
    const rad = (aDeg * Math.PI) / 180;
    if (inRotEllipse(p, { x: 0.555 + Math.cos(rad) * 0.065, y: 0.695 - Math.sin(rad) * 0.065 },
      { x: Math.cos(rad), y: -Math.sin(rad) }, 0.075, 0.02)) {
      return 1;
    }
  }
  // 飞羽 5 片（向画布左上扬；k=0 最长近竖直，k=4 最短近水平向左）
  const shoulder: Pt = { x: 0.525, y: 0.42 };
  for (let k = 0; k < 5; k += 1) {
    const aDeg = 96 + k * 16;
    const rad = (aDeg * Math.PI) / 180;
    const dir: Pt = { x: Math.cos(rad), y: -Math.sin(rad) };
    const len = 0.3 - k * 0.022;
    if (inRotEllipse(p,
      { x: shoulder.x + dir.x * len * 0.5, y: shoulder.y + dir.y * len * 0.5 },
      dir, len * 0.5 + 0.015, 0.026 - k * 0.002)) {
      return k <= 1 ? 2 : 1;
    }
  }
  return 0;
}

/** 确定性伪随机（点亮度抖动；node/browser 两侧同一序列） */
function hash2(i: number, j: number): number {
  const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * 点阵面板绘制（纯函数）：暗底 + 全网格微光「熄灭点」+ 鹰形金色「点亮」点阵。
 * 20×32 格；点亮点半径 0.33 格、熄灭点 0.20 格 —— 读成 LED 点阵屏而非剪影。
 */
export function paintEaglePanel(p: EaglePanelPainter, w: number, h: number): void {
  p.fill(w, h, '#0c0a06');
  const cw = w / EAGLE_PANEL.cols;
  const ch = h / EAGLE_PANEL.rows;
  for (let j = 0; j < EAGLE_PANEL.rows; j += 1) {
    for (let i = 0; i < EAGLE_PANEL.cols; i += 1) {
      const x = (i + 0.5) * cw;
      const y = (j + 0.5) * ch;
      const m = eagleMask((i + 0.5) / EAGLE_PANEL.cols, (j + 0.5) / EAGLE_PANEL.rows);
      if (m === 0) {
        p.circle(x, y, cw * 0.2, 'rgba(154,120,52,0.20)');
      } else {
        const light = 46 + (m === 2 ? 16 : 0) + Math.round(hash2(i, j) * 14);
        p.circle(x, y, cw * 0.33, `hsl(43, 84%, ${light}%)`);
      }
    }
  }
}

/**
 * 鹰形点阵 canvas 贴图。node（无 DOM）环境返回 null —— 调用方降级为无图金色材质，
 * QA shim 的 bbox/tri/镜像/法线校验不受影响。
 */
export function makeEaglePanelTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  paintEaglePanel(
    {
      fill: (w, h, color) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, h);
      },
      circle: (x, y, r, color) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    canvas.width,
    canvas.height
  );
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ================================================================
 * 4. 独占材质工厂（零外部图片；id 全 r21-tail-lamp-*）
 * ================================================================ */

export function createTailLampMaterials(eagleTexture?: THREE.Texture | null): TailLampMaterials {
  const mk = (
    id: string,
    params: THREE.MeshStandardMaterialParameters
  ): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...params });
    m.userData.sculptMaterial = { id };
    return m;
  };
  const tex = eagleTexture === undefined ? makeEaglePanelTexture() : eagleTexture;
  const gold = tex
    ? mk(TAIL_LAMP_MATERIAL_IDS.gold, {
        // map 与 emissiveMap 同源：暗底乘白 emissive 仍暗，金点发光 —— 待机低亮度
        color: 0xffffff, map: tex, emissive: 0xffffff, emissiveMap: tex,
        emissiveIntensity: TAIL_LAMP_STANDBY.gold, metalness: 0.1, roughness: 0.5
      })
    : mk(TAIL_LAMP_MATERIAL_IDS.gold, {
        // 无图降级（node shim）：只保留暗底 + 弱金光，保证 QA 几何校验可跑。
        // R23 look-dev：emissiveIntensity 由 0.35 → 0.50（≈×1.45，与带图口径同比例）
        color: 0x0f0c06, emissive: 0xd9a84e, emissiveIntensity: 0.50,
        metalness: 0.1, roughness: 0.5
      });
  return {
    housing: mk(TAIL_LAMP_MATERIAL_IDS.housing, {
      color: 0x0d0f12, metalness: 0.35, roughness: 0.5
    }),
    chrome: mk(TAIL_LAMP_MATERIAL_IDS.chrome, {
      // R23 look-dev：黄昏环境反光弱 → metalness 保持 1.0、roughness 0.14→0.09、
      // 新增 envMapIntensity 1.6，使 RoomEnvironment 黄昏高光明显但不镜面过曝。
      color: 0xdfe2e8, metalness: 1.0, roughness: 0.09, envMapIntensity: 1.6
    }),
    red: mk(TAIL_LAMP_MATERIAL_IDS.red, {
      color: 0x7e1220, emissive: 0xe03040, emissiveIntensity: TAIL_LAMP_STANDBY.red,
      metalness: 0.0, roughness: 0.22
    }),
    gold
  };
}

/* ================================================================
 * 5. 主构造
 * ================================================================ */

export function createTailLamp(options: TailLampOptions = {}): TailLampResult {
  const side = options.side ?? 'left';
  const materials = options.materials ?? createTailLampMaterials(options.eagleTexture);

  // ---- 5.1 深色背板：z ∈ [HOUSING_FRONT, HOUSING_FRONT + HOUSING_DEPTH] ----
  const housingGeo = at(
    extrude(roundedRectShape(LAMP_W - 0.012, LAMP_H - 0.012, 0.03), HOUSING_DEPTH, 0),
    0, 0, HOUSING_FRONT
  );

  // ---- 5.2 镀铬包边：front = -PROTRUDE，back 嵌进背板 1mm（无 bevel：bbox 0.17×0.46 逐位守约）----
  const bezelGeo = at(
    extrude(
      roundedRectFrameShape(
        LAMP_W, LAMP_H, 0.034,
        LAMP_W - BEZEL_FRAME_W * 2, LAMP_H - BEZEL_FRAME_W * 2, 0.026
      ),
      BEZEL_DEPTH, 0
    ),
    0, 0, -PROTRUDE
  );

  // ---- 5.3 红色灯刃 ×5：顶 3 底 2，微斜切，back 嵌进背板 0.5mm ----
  const bladeParts: THREE.BufferGeometry[] = [];
  for (const yc of [...TAIL_LAMP_BLADES.top, ...TAIL_LAMP_BLADES.bottom]) {
    const g = extrude(
      roundedRectShape(TAIL_LAMP_BLADES.width, TAIL_LAMP_BLADES.height, TAIL_LAMP_BLADES.radius),
      TAIL_LAMP_BLADES.depth, 0
    );
    g.rotateZ(TAIL_LAMP_BLADES.slantRad);
    bladeParts.push(at(g, 0, yc, TAIL_LAMP_BLADES.z));
  }
  const bladeGeo = mergeSafe(bladeParts);

  // ---- 5.4 鹰形点阵屏：单面 quad（tri 预算优先贴图方案）----
  // PlaneGeometry 默认朝 +z；rotateY(π) 后 front 朝 -z（= 外露方向）。
  // 画布 u=1（图右）落到局部 -x ⇒ 画布左 = 局部 +x = 世界车中向（左灯），故
  // eagleMask 把翼展画在画布左侧；右侧经 −x 镜像自然对称。
  const eagleGeo = new THREE.PlaneGeometry(EAGLE_PANEL.w, EAGLE_PANEL.h);
  eagleGeo.rotateY(Math.PI);
  eagleGeo.translate(0, EAGLE_PANEL.y, EAGLE_PANEL.z);

  // ---- 5.5 装配：每材质 1 个 mesh ----
  const group = new THREE.Group();
  group.name = side === 'right' ? 'taillamp-r-hand' : 'taillamp-l-hand';
  group.userData.sculptComponent = { id: group.name };

  const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): void => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    group.add(mesh);
  };
  addMesh(housingGeo, materials.housing, 'tl-housing');
  addMesh(bezelGeo, materials.chrome, 'tl-bezel');
  addMesh(bladeGeo, materials.red, 'tl-blades');
  addMesh(eagleGeo, materials.gold, 'tl-eagle');

  // ---- 5.6 左右镜像：纯 −x 镜像，非旋转（DoubleSide 兜绕序）----
  if (side === 'right') {
    group.scale.x = -1;
  }

  // ---- 5.7 tri 统计 ----
  let triangleCount = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    triangleCount += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  });
  group.updateMatrixWorld(true);

  return { group, materials, triangleCount };
}
