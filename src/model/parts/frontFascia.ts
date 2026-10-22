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
 *   front-end 局部系 = spec 中 front-end 节点的子节点坐标系。front-end 自身 transform：
 *     position [0, 0.86, 2.33]，rotation [-0.12, 0, 0]，parent = root。
 *   ⚠️ R24-B 实测勘误：旧注释写 scale [1.062, 0.46, 1]，但 headless 探针
 *   （.qa/r24_b_probe.mjs，#assembled + 裸模型双跑）实测 front-end 及其全部子件
 *   world scale = **[1, 1, 1]**（ff-trim 世界 0.92×0.169 与其局部尺寸逐位吻合）。
 *   旧注释的 [1.062,0.46,1] 是某版 spec 的陈值 —— 本文件所有「局部 = 世界/缩放」
 *   的换算按旧值反推会把尺寸放大 1/0.46 ≈ 2.2 倍（字标曾被放成 16cm 高）。
 *   本轮起 FE_SCALE 以实测为准 = 1，**局部米 = 世界米**。
 *   root 的 scale [2.006,1.78,5.44] 是宏容器占位盒（生成期被隐藏/忽略），不作用于子节点矩阵；
 *   子节点（bumper-lower / chrome-brow / front-light-bar / headlamp-l/r）的 transform 直接以
 *   绝对世界米表达（仅再叠加 front-end 的 rotX(-0.12)）。
 *   ★ 车头 +Z 件不需要 rotY(π)（与 tailLamp 相反）：挤出沿 0→depth，front face 落在 +z。
 *
 *   实测兄弟件 world bbox（R24-B 探针，工厂系车头 +Z）：
 *     front-end 面板   x±0.97  y[0.62, 1.109]  z[2.301, 2.438]
 *     bumper-lower     x±0.96  y[0.245,0.574]  z[2.200, 2.337]
 *     chrome-brow      x±0.92  y[1.041,1.138]  z[2.383, 2.453]   ← 字标纵向包络上界
 *     front-light-bar  x±0.31  y[0.921,0.937]  z[2.434, 2.455]
 *     shield-logo      x±0.045 y[0.661,0.901]  z[2.465, 2.506]   ← 中央盾标（bronze，最前）
 *     shield-emblem-panel  x±0.030 y[0.808,0.977] z[2.421,2.445]  ← 曜日纹发光面板（被盾标遮挡）
 *   本件落位因此以「chrome-brow 下沿 1.041」为字标纵向硬上界（见下方锚点注释）。
 *
 *   本件局部落位（front-end 局部系，单位=局部米=世界米；rotX(-0.12) 仅微调世界 y/z）：
 *     grillePanel  中心 (0, -0.060, 0.075)，尺寸 (1.20 × 0.62 × 0.02)m
 *     hoodTrim     中心 (0,  0.100, 0.100)，尺寸 (0.92 × 0.10  × 0.016)m
 *     maextroLetters 中心 (0, 0.100, 0.112)，总宽 0.80m，单字母 0.080 × 0.109m
 *                  笔画 15.5mm（R24-B；旧 11mm）
 *   整组 world 中心约 (0, 0.91~1.04, 2.41~2.45)，与前脸中央其余件同区、互不穿模。
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

/**
 * front-end 节点对子节点的缩放。
 * ⚠️ R24-B 实测勘误：旧值 {1.062, 0.46, 1.0} 来自陈旧 spec 注释；headless 探针实测
 * front-end 及其子件 world scale = [1,1,1]（.qa/r24_b_probe.mjs，ff-trim 世界 0.92×0.169
 * 与局部尺寸逐位吻合）。局部米 = 世界米。保留本常量仅为兼容 toFeLocal 调用方与
 * 「笔画厚度按朝向反算」的通用公式 —— 若未来 spec 重新引入 front-end 缩放，只改这里。
 */
export const FE_SCALE = { x: 1.0, y: 1.0, z: 1.0 } as const;

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

/** 局部落位（front-end 局部系；与头部注释一致，供集成层校核）
 *
 *  R24-B 字标加粗：笔画 11mm → 15.5mm（+41%，任务书 30–50% 区间），字高/落位/trim
 *  尺寸一律不动（实测 scale=1 后字高本就是 109mm；加粗后字组纵向包络
 *  0.0378..0.1623 局部米 → 世界 y 0.911..1.035，距 chrome-brow 下沿 1.041 仍有
 *  6.5mm 净空，与 R23-D 原包络一致，不新增任何遮挡）。
 */
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

/** 单元格尺寸（front-end 局部米 = 世界米，FE_SCALE 实测为 1，见头部勘误） */
const LW = 0.080; // 单字母宽
/** 单字母高 0.109m —— R24-B 维持原值：实测 scale=1 后字母本就 10.9cm 高
 *  （旧注释的「世界 5cm」是按陈旧 scale 0.46 反推的误标），无需再 +20%。 */
const LH = 0.109;
const LETTER_DEPTH = 0.014;

/**
 * 笔画宽度（米，R24-B 新口径）。
 * 旧值 `STROKE_T = 0.011`（11mm）在 80×109mm 的字母上只占字宽 13.75%，
 * 远景下笔画亚像素化、七字母糊成一条白横带（外部审查 R21–R23 P2）。
 * 取 15.5mm = +41%（落在任务书的 30–50% 区间）。上限约束：E 的三横要留出
 * ≥ 笔画宽的可分辨暗间隙 ⇒ 字高 ≥ 4×笔画宽（4 × 15.5 = 62mm < 109mm ✓，
 * E 横间净隙 3.9cm）。发光强度不动（emissiveIntensity 1.7 原样保留）。
 */
const STROKE_WORLD = 0.0155;
/** 笔画厚度沿局部 X 的取值（竖笔左右宽度） */
const STROKE_LOCAL_X = STROKE_WORLD / FE_SCALE.x;
/** 笔画厚度沿局部 Y 的取值（横笔上下厚度） */
const STROKE_LOCAL_Y = STROKE_WORLD / FE_SCALE.y;

/**
 * 任意朝向笔画的局部厚度：笔画盒经 rotateZ(ang) 后，局部 Y 轴（厚度方向）落在
 * 单位向量 p = (−sin ang, cos ang)；该方向经 FE_SCALE 后的世界长度
 * |(p.x·sx, p.y·sy)| 即「1 局部米 = 多少世界米」，用世界目标宽除之即得局部厚度。
 */
function strokeLocal(ang: number): number {
  const worldPerLocal = Math.hypot(Math.sin(ang) * FE_SCALE.x, Math.cos(ang) * FE_SCALE.y);
  return STROKE_WORLD / Math.max(worldPerLocal, 1e-6);
}

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
  // R24-B：厚度按朝向反算（世界等宽 STROKE_WORLD），不再用固定局部值
  const g = new THREE.BoxGeometry(len, strokeLocal(ang), LETTER_DEPTH);
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
      // 圆角框：外 0.080×0.109m；内孔按笔画 15.5mm 反算（FE_SCALE 实测为 1，
      // STROKE_LOCAL_X/Y ≡ STROKE_WORLD；公式保留以便未来 spec 重引入缩放时仍等宽）。
      const o = roundedRectFrameShape(
        LW, LH, 0.022,
        LW - 2 * STROKE_LOCAL_X, LH - 2 * STROKE_LOCAL_Y,
        0.012, 6
      );
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
