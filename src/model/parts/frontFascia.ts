/**
 * frontFascia.ts —— V800 前脸封闭格栅面板 + 引擎盖前端 MAEXTRO 发光字标手写几何（R23-D）
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 接线说明（本文件只产部件 + 材质，不接线；接线由集成层在                      │
 * │ V800Adapter.ts 的 R23-D 区块完成，严禁在此文件外改 Adapter / spec / 工厂） │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 交付内容（全部程序化生成，零外部资产；无 FontLoader / 无贴图）：
 *   1) grillePanel   前脸封闭格栅面板（车身同色深色金属漆，半哑光，水平宽矩形 + 圆角）。
 *   2) hoodTrim      引擎盖前缘横向饰条（字标嵌 herein），深色，略凸于格栅面。
 *   3) maextroLetters 引擎盖前端 MAEXTRO 发光字母（7 字母，线段式笔画几何 + emissive 白）。
 *   整组作为一个 Group 返回，由集成层挂到 front-end 下（同 bumper-lower / chrome-brow 的
 *   兄弟节点），并加入 batchMerge 的 excludeObjects，独占材质不被并进全车批次。
 *
 * 坐标 / 锚点（★ 与头灯同律：本部件挂在 front-end 下，几何按 front-end 局部系构建）：
 *   front-end 局部系 = spec 中 front-end 节点的子节点坐标系。实测 front-end 自身 transform：
 *     position [0, 0.86, 2.33]，rotation [-0.12, 0, 0]，scale [1.062, 0.46, 1]，parent = root。
 *   root 的 scale [2.006,1.78,5.44] 是宏容器占位盒（生成期被隐藏/忽略），不作用于子节点矩阵；
 *   子节点（bumper-lower / chrome-brow / front-light-bar / headlamp-l/r）的 transform 直接以
 *   绝对世界米表达（仅再叠加 front-end 的 [1.062,0.46,1] + rotX(-0.12)）。
 *   因此本文件几何一律用「front-end 局部米」书写，并按下式把目标世界米换算成局部米，
 *   使最终渲染尺寸贴合视觉参考（车头 +Z，鼻尖世界 z≈+2.72）：
 *     local = world / front-end.scale  即  localX = w/1.062, localY = h/0.46, localZ = d/1.0
 *   ★ 车头 +Z 件不需要 rotY(π)（与 tailLamp 相反）：挤出沿 0→depth，front face 落在 +z。
 *
 *   实测兄弟件 front-end 局部锚点（world = front-end 矩阵作用后，root 忽略）：
 *     bumper-lower  局部 y∈[-0.60,-0.28]  → 世界 y≈0.64 / 顶 0.714，z∈[-0.165,-0.065]
 *     chrome-brow   局部 y∈[0.1725,0.2625]→ 世界 y≈0.94 / 0.98， z∈[0.085,0.145]  (最前缘饰条)
 *     front-light-bar 局部 y≈0.055, z≈0.112 → 世界 y≈0.90, z≈2.44
 *     headlamp-l/r  局部 x=±0.8, y≈-0.074, z≈0.081 (本件 x 半宽 0.60 → 与之错开，不 z-fight)
 *   中央净空带（保险杠顶 0.714 ~ 镀铬上沿底 0.939）≈ 0.225m 世界高。参考图格栅高 ≈0.30m
 *   略超净空，故本件取世界高 ≈0.285m（局部 0.62）：顶 ≈世界 0.97 与 chrome-brow(0.94~0.98)
 *   交叠极小且本件 z 退于其前缘(0.145) 被遮挡、底略前于 bumper(-0.065) 仅覆其顶极少部分，
 *   不产生共面闪烁。
 *
 *   本件局部落位（front-end 局部系，单位=局部米；* 标注为换算前的目标世界米）：
 *     grillePanel  中心 (0, -0.060, 0.075)，尺寸 (1.20 × 0.62 × 0.02)   *世界 1.27×0.285×0.02m
 *     hoodTrim     中心 (0,  0.100, 0.100)，尺寸 (0.92 × 0.10  × 0.016)*世界 0.98×0.046×0.016m
 *     maextroLetters 中心 (0, 0.100, 0.112)，总宽 0.80 *世界 0.85m，单字母高 0.109 *世界 0.05m
 *   整组 world 中心约 (0, 0.83~0.91, 2.42~2.45)，与前脸中央其余件同区、互不穿模。
 *
 * 几何约定（与 project 铁律 / headLamp / tailLamp 一致）：
 *   · profile / 轮廓一律 CCW（shoelace>0），ExtrudeGeometry 前向法线朝外；
 *   · 挤出沿 +z（0→depth），position 即挤出底面 z，front face = z+depth（无需 depth/2 补偿，
 *     因本件直接落位到目标 front z，与 headLamp 的 FRONT_Z 写法同律）；
 *   · 材质统一 DoubleSide 兜住镜像/薄件；本件单组、无左右镜像（纯前脸 +Z，非左右分件）；
 *   · tri 预算：面板+饰条+字标合计 ≤ 2500（实测 ≈ 0.8k，见下方 triangleCount 与报告）。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

/* ================================================================
 * 0. front-end 局部系换算常量 + 落位（注释见头部）
 * ================================================================ */

/** front-end 节点对非根子节点的缩放（root 占位盒缩放不作用，见头部说明） */
export const FE_SCALE = { x: 1.062, y: 0.46, z: 1.0 } as const;

/** 把目标世界米换算成 front-end 局部米（供集成层校核 / 二次开发参考） */
export function toFeLocal(worldW: number, worldH: number, worldD: number): [number, number, number] {
  return [worldW / FE_SCALE.x, worldH / FE_SCALE.y, worldD / FE_SCALE.z];
}

/* ================================================================
 * 1. 对外类型 / 联动常量
 * ================================================================ */

export interface FrontFasciaMaterials {
  /** 封闭格栅面板：车身同色深色金属漆（半哑光，独占） */
  grille: THREE.MeshStandardMaterial;
  /** 引擎盖前缘横向饰条（字标嵌 herein，独占） */
  trim: THREE.MeshStandardMaterial;
  /** MAEXTRO 发光字母（emissive 白/银白，独占） */
  letter: THREE.MeshStandardMaterial;
}

export interface FrontFasciaOptions {
  /** 复用外部材质实例（接线时左右/整组共用同一份，避免重复 DC） */
  materials?: FrontFasciaMaterials;
}

export interface FrontFasciaResult {
  /** 在 front-end 局部系原点构建的 Group（整组挂到 front-end 即可） */
  group: THREE.Group;
  /** 本部件用到的 3 个独占材质 */
  materials: FrontFasciaMaterials;
  /** 本组三角形总数（索引/非索引统一折算） */
  triangleCount: number;
}

/** 独占材质 id（batchMerge / 落地审查寻址用；绝不并入共享批次） */
export const FRONT_FASCIA_MATERIAL_IDS = {
  grille: 'r23-front-fascia-grille',
  trim: 'r23-front-fascia-trim',
  letter: 'r23-front-fascia-letter'
} as const;

/** 本件为「新增」前脸总成，无既有 spec 组件可替换（shield-logo / shield-emblem-panel 是
 *  中央盾标，与 MAEXTRO 字标无关，不在此列）。挂载方式见头部：作为 front-end 子节点新增。 */
export const FRONT_FASCIA_REPLACE_IDS: readonly string[] = [];

/** 局部落位（front-end 局部系；与头部注释一致，供集成层校核） */
export const FRONT_FASCIA_ANCHORS = {
  grille: { pos: [0, -0.06, 0.075] as [number, number, number], size: [1.20, 0.62, 0.02] as [number, number, number] },
  trim: { pos: [0, 0.10, 0.10] as [number, number, number], size: [0.92, 0.10, 0.016] as [number, number, number] },
  letters: { pos: [0, 0.10, 0.112] as [number, number, number], width: 0.80, cell: 0.080, gap: 0.040, height: 0.109, depth: 0.014 }
} as const;

/* ================================================================
 * 2. 形状 / 挤出辅助（全部 CCW，同 headLamp）
 * ================================================================ */

/** 圆角矩形轮廓（CCW，中心在原点） */
function roundedRectShape(w: number, h: number, r: number, _seg = 6): THREE.Shape {
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

/** 圆角矩形「框」（外 CCW + 内孔反向），字母 O 用 */
function roundedRectFrameShape(
  w: number, h: number, r: number,
  iw: number, ih: number, ir: number,
  seg = 6
): THREE.Shape {
  const outer = roundedRectShape(w, h, r, seg);
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

/** 挤出 0→depth（front cap 在 z=depth）；bevel>0 时两端各外扩 bevel */
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

/** 把几何平移到目标位置（合并同材质件前，先烘焙好各自偏移） */
function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  g.computeBoundingBox();
  return g;
}

/* ================================================================
 * 3. MAEXTRO 字标：线段式笔画几何（零图、零字体）
 * ================================================================ */

/** 单元格局部尺寸（front-end 局部米；世界 0.085×0.05m） */
const LW = 0.080; // 单字母宽（局部）
const LH = 0.109; // 单字母高（局部）
const LETTER_DEPTH = 0.014;
const STROKE_T = 0.011; // 笔画厚度（局部，统一）

/**
 * 每字母的归一化笔画 [x0,y0,x1,y1]（x:0→1 左→右，y:0→1 底→顶，单元格 1×1）。
 * 用线段式简化大写无衬线；O 走圆角框（下方单独处理）。
 */
const LETTER_STROKES: Record<string, [number, number, number, number][]> = {
  M: [[0.12, 0, 0.12, 1], [0.88, 0, 0.88, 1], [0.12, 1, 0.5, 0.28], [0.88, 1, 0.5, 0.28]],
  A: [[0.1, 0, 0.5, 1], [0.9, 0, 0.5, 1], [0.27, 0.55, 0.73, 0.55]],
  E: [[0.2, 0, 0.2, 1], [0.2, 1, 0.85, 1], [0.2, 0.5, 0.72, 0.5], [0.2, 0, 0.82, 0]],
  X: [[0.1, 0, 0.9, 1], [0.9, 0, 0.1, 1]],
  T: [[0.12, 1, 0.88, 1], [0.5, 0, 0.5, 1]],
  R: [[0.22, 0, 0.22, 1], [0.22, 1, 0.8, 1], [0.8, 1, 0.8, 0.62], [0.22, 0.62, 0.7, 0.62], [0.46, 0.55, 0.9, 0]]
};

const WORD = 'MAEXTRO';
const TOTAL_WIDTH = FRONT_FASCIA_ANCHORS.letters.width; // 0.80 局部
const STEP = LW + FRONT_FASCIA_ANCHORS.letters.gap; // 0.120 局部

/** 构建单条笔画（薄盒沿笔画方向，端点居中） */
function strokeBox(x0n: number, y0n: number, x1n: number, y1n: number): THREE.BufferGeometry {
  const x0 = x0n * LW;
  const y0 = y0n * LH;
  const x1 = x1n * LW;
  const y1 = y1n * LH;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const g = new THREE.BoxGeometry(len, STROKE_T, LETTER_DEPTH);
  g.rotateZ(ang);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
  return g;
}

/** 构建整行 MAEXTRO（已烘焙到最终 front-end 局部落位：中心 x=0, y=0.10, z=0.112） */
function buildMaextroLetters(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const baseY = FRONT_FASCIA_ANCHORS.letters.pos[1] - LH / 2; // 单元格底对齐到中心
  const baseZ = FRONT_FASCIA_ANCHORS.letters.pos[2];
  const startX = -TOTAL_WIDTH / 2;
  for (let i = 0; i < WORD.length; i += 1) {
    const ch = WORD[i];
    const letterCenterX = startX + i * STEP + LW / 2;
    if (ch === 'O') {
      // 圆角框：外 0.080×0.109 / 内 0.040×0.049，前缘朝 +z（形状居中于原点）
      const o = roundedRectFrameShape(LW, LH, 0.022, LW - 2 * STROKE_T, LH - 2 * STROKE_T, 0.012, 6);
      const g = extrude(o, LETTER_DEPTH, 0);
      g.translate(letterCenterX, baseY + LH / 2, baseZ);
      parts.push(g);
      continue;
    }
    const strokes = LETTER_STROKES[ch];
    if (!strokes) continue;
    for (const [x0n, y0n, x1n, y1n] of strokes) {
      // strokeBox 在单元格局部（x∈[0,LW], y∈[0,LH]，中点已居中）构建笔画，
      // 这里把整格平移到 letterCenterX（格中心）/ baseY（格底）/ baseZ。
      const g = strokeBox(x0n, y0n, x1n, y1n);
      g.translate(letterCenterX - LW / 2, baseY, baseZ);
      parts.push(g);
    }
  }
  const merged = mergeSafe(parts);
  merged.computeBoundingBox();
  return merged;
}

/* ================================================================
 * 4. 独占材质工厂（零外部图片；id 全 r23-front-fascia-*）
 * ================================================================ */

export function createFrontFasciaMaterials(): FrontFasciaMaterials {
  const mk = (
    id: string,
    params: THREE.MeshStandardMaterialParameters
  ): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...params });
    m.userData.sculptMaterial = { id };
    return m;
  };
  return {
    // 车身同色深色金属漆（半哑光）：匹配 paint-upper #0F0F12 基色，roughness 上调至半哑光
    grille: mk(FRONT_FASCIA_MATERIAL_IDS.grille, {
      color: 0x0f0f12, metalness: 0.55, roughness: 0.42
    }),
    // 引擎盖前缘饰条：略亮的深色，让字标浮起
    trim: mk(FRONT_FASCIA_MATERIAL_IDS.trim, {
      color: 0x14161b, metalness: 0.5, roughness: 0.5
    }),
    // MAEXTRO 发光字母：银灰底 + 白 emissive，适中强度
    letter: mk(FRONT_FASCIA_MATERIAL_IDS.letter, {
      color: 0xdfe4ec, emissive: 0xffffff, emissiveIntensity: 1.7,
      metalness: 0.25, roughness: 0.4
    })
  };
}

/* ================================================================
 * 5. 主构造
 * ================================================================ */

export function createFrontFascia(options: FrontFasciaOptions = {}): FrontFasciaResult {
  const materials = options.materials ?? createFrontFasciaMaterials();

  // ---- 5.1 封闭格栅面板：水平宽矩形 + 圆角，半哑光深色漆 ----
  const grilleGeo = at(
    extrude(
      roundedRectShape(
        FRONT_FASCIA_ANCHORS.grille.size[0],
        FRONT_FASCIA_ANCHORS.grille.size[1],
        0.05, 6
      ),
      FRONT_FASCIA_ANCHORS.grille.size[2],
      0.003
    ),
    FRONT_FASCIA_ANCHORS.grille.pos[0],
    FRONT_FASCIA_ANCHORS.grille.pos[1],
    FRONT_FASCIA_ANCHORS.grille.pos[2]
  );

  // ---- 5.2 引擎盖前缘横向饰条（字标嵌 herein） ----
  const trimGeo = at(
    extrude(
      roundedRectShape(
        FRONT_FASCIA_ANCHORS.trim.size[0],
        FRONT_FASCIA_ANCHORS.trim.size[1],
        0.03, 4
      ),
      FRONT_FASCIA_ANCHORS.trim.size[2],
      0
    ),
    FRONT_FASCIA_ANCHORS.trim.pos[0],
    FRONT_FASCIA_ANCHORS.trim.pos[1],
    FRONT_FASCIA_ANCHORS.trim.pos[2]
  );

  // ---- 5.3 MAEXTRO 发光字母（程序化线段几何，已烘焙落位） ----
  const letterGeo = buildMaextroLetters();

  // ---- 5.4 装配：每材质 1 个 mesh，挂到 Group ----
  const group = new THREE.Group();
  group.name = 'front-fascia-hand';
  group.userData.sculptComponent = { id: 'front-fascia' };

  const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): void => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    group.add(mesh);
  };
  addMesh(grilleGeo, materials.grille, 'ff-grille');
  addMesh(trimGeo, materials.trim, 'ff-trim');
  addMesh(letterGeo, materials.letter, 'ff-letters');

  // ---- 5.5 统计 tri 数 ----
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
