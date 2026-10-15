/**
 * 运行时静态合批：把「同一材质 + 全程静止」的小件按材质合并成单 mesh，
 * 用 1 个 draw call 顶替 N 个。
 *
 * 为什么面数有余而 DC 贴红线时必须做这件事：
 * PERF.md 实测整车 89 visible mesh ≈ 89 DC，而 22,656 面只占 58,000 预算的 39%。
 * 瓶颈在 CPU 侧提交（draw call），不在 GPU 几何处理，所以这一刀是砍在正确的地方。
 *
 * 合并前必须把每个 mesh 的 matrixWorld 烘焙进 geometry（相对合并目标父节点），
 * 否则零件的世界位置会全部飞掉。
 *
 * 安全判定是多层的，缺一不可（合批最忌把会动的件合进去，一错就是整车穿帮）：
 *  1. 显式排除：调用方给出的动态根节点（含其整棵子树）+ 内置 ID 模式（wheel-/cap-/…）。
 *  2. spec metadata：工厂自己的 actionProfile 声明了 transform 通道或 animationRole≠static 的一律跳过。
 *     这是独立于调用方的第二道判据 —— 实测它比运行时写入清单多抓出 6 个对象
 *     （steering 的 role=steer、crystal-sconce-l/r 与其 band 件的 role=counter-rotate-lock），
 *     这些件当前没被逐帧写，但一旦接线就会动，宁可少省 3 个 DC。
 *  3. 可见性与材质形态：不可见件、多材质件、透明/透射件不参与合并。
 *  4. 内容型贴图材质（screen-ui / gauge-ui / starlight / crystal）：保留逐件 UV 语义。
 *
 * 合并后自校验：确认所有显式排除对象仍在场景图里（没被合掉）。
 */
import * as THREE from 'three';
import { mergeSafe } from '../util/geo';

export type SkipReason =
  | 'multi-material'
  | 'hidden'
  | 'explicit-exclusion'
  | 'animated-in-spec'
  | 'transparent'
  | 'uv-content-material'
  | 'merge-failed';

export interface SkippedMesh {
  id: string;
  materialId: string;
  reason: SkipReason;
  detail: string;
}

export interface BatchMergeGroup {
  materialId: string;
  meshesIn: number;
  meshesOut: number;
  triangles: number;
}

export interface BatchMergeResult {
  /** 合并前子树里的 Mesh 总数（含不可见） */
  meshesBefore: number;
  /** 合并后子树里的 Mesh 总数 */
  meshesAfter: number;
  /** 合并前「会被渲染」的 Mesh 数 = 可见且祖先全可见 */
  drawCallsBefore: number;
  /** 合并后「会被渲染」的 Mesh 数 */
  drawCallsAfter: number;
  /** drawCallsBefore − drawCallsAfter，即腾出来的 draw call 预算 */
  drawCallReduction: number;
  trianglesBefore: number;
  trianglesAfter: number;
  groups: BatchMergeGroup[];
  skipped: SkippedMesh[];
  /** 显式排除清单（供审查，含内置模式） */
  excludedIds: string[];
  created: THREE.Mesh[];
  /** 自校验发现的问题（空 = 全部通过） */
  problems: string[];
}

export interface BatchMergeOptions {
  /** 显式排除的动态根节点：整棵子树都不参与合并 */
  excludeObjects?: readonly THREE.Object3D[];
  /** 额外的组件 ID 精确排除（命中自身或任一祖先 → 整棵子树排除） */
  excludeIds?: readonly string[];
  /** 额外的组件 ID 正则排除 */
  excludePatterns?: readonly RegExp[];
  /** 内容型贴图材质的 ID 排除清单（默认见 UV_CONTENT_MATERIAL_IDS） */
  excludeMaterialIds?: readonly string[];
  /** 合并后的 mesh 挂到哪个父节点，默认是被遍历的 root 本身 */
  mergeTarget?: THREE.Object3D;
  /** 是否尊重工厂 actionProfile 的动静态声明，默认 true */
  respectAnimationMetadata?: boolean;
  /** 是否跳过透明/透射材质（合批会让多个透明件失去逐件深度排序），默认 true */
  skipTransparent?: boolean;
  /** 一组至少几个 mesh 才值得合并，默认 2 */
  minGroupSize?: number;
  /** 是否 dispose 被吞并掉的源几何体，默认 true */
  disposeConsumed?: boolean;
}

/**
 * UV_CONTENT_MATERIAL_IDS —— 「内容型」贴图材质的合批排除契约。
 *
 * ⚠️ 先澄清：这条排除**不是在修复任何现存缺陷**。合批不会破坏 UV。
 * 合并只是拼接顶点数组，每个源几何体保留各自的 UV 属性值，各自采样各自那段贴图区域 ——
 * 实测（141 mesh 版，15+ 组合并、17,882 个顶点逐点比对）UV 误差 = 0.000e+0，未匹配顶点 0。
 * 唯一会出问题的情形是「多个 mesh 各持不同贴图却塞进同一材质实例」，
 * 而本工具的分组主键是**材质对象引用**，那种情形本来就不会被合并。
 *
 * 那为什么还要排除：这几个材质的贴图承载的是**画面内容**（UI 画面 / 星空图案 / 灯箱点阵），
 * 而不是可平铺的表面纹理（皮革/木纹/窗帘那类 map 全车通用，合批照合不误）。
 * 集成层会在运行时给其中几个**换贴图**（仪表 gaugeTex、星空顶 emissiveMap），
 * 一旦将来某个 spec 版本把它们拆成多个实例、或做逐件换图，
 * 合批就会让"换一张图"连带影响同组其他 mesh —— 那是很难查的串味 bug。
 * 所以这是一份**面向未来的防御契约**：用 0 draw call 的代价把这条歧义彻底掐死。
 *
 * 为什么代价是 0：当前工况下这四个材质每组只有 1 个成员（合不成组）；
 * 唯一有 2 个成员的 crystal 已被「透明」与「counter-rotate」前两层判据拦下。
 * 工厂升级到更多 micro 组件后此处的收益/代价需要重新量一次。
 */
export const UV_CONTENT_MATERIAL_IDS: readonly string[] = [
  'screen-ui', // tri-screen 等：Canvas UI 贴图
  'gauge-ui', // 仪表：适配器运行时替换 map
  'starlight', // 星空顶：适配器运行时生成 emissiveMap
  'crystal' // 水晶壁灯：折射/发光
];

/**
 * 内置排除模式。
 * 这六条来自 V800Adapter.update()/spinWheels() 的逐帧写入事实：
 * 轮子 pivot 每帧写 rotation.x、悬浮轮标每帧写 quaternion。
 * 即使调用方忘了传 excludeObjects，这层也能挡住。
 */
const DEFAULT_EXCLUDE_PATTERNS: readonly RegExp[] = [
  /^wheel-/, // wheel-fl/fr/rl/rr pivot（每帧 rotation.x）+ wheel-cap-*（每帧 quaternion）
  /^tire-/,
  /^rim-/,
  /^cap-/, // 旧命名的轮标兜底
  /^brake-pedal$/, // 集成层踏板：每帧写 position/rotation/visible
  /^gauge-screen$/ // 集成层仪表：适配器持有 mesh 引用
];

/** actionProfile 里标记为"会动"的 transform 通道 */
const MOTION_CHANNELS = ['translate', 'rotate', 'scale', 'bend', 'twist', 'detach'] as const;

function componentIdOf(o: THREE.Object3D): string | undefined {
  const a = (o.userData?.sculptComponent as { id?: unknown } | undefined)?.id;
  if (typeof a === 'string' && a) return a;
  const b = (o.userData?.component as { id?: unknown } | undefined)?.id;
  if (typeof b === 'string' && b) return b;
  return undefined;
}

/** actionProfile 在 pivot 节点和 mesh 上各挂一份，mesh 上的那份随 sculptComponent 走 */
function actionProfileOf(o: THREE.Object3D): Record<string, unknown> | undefined {
  const own = o.userData?.actionProfile as Record<string, unknown> | undefined;
  if (own) return own;
  return o.userData?.sculptComponent?.actionProfile as Record<string, unknown> | undefined;
}

/**
 * spec 是否声明这个对象（或其祖先）会动。
 * 这是独立于运行时调用方的第二道判据：以工厂自己的数据为准，不靠猜 ID。
 */
function specSaysAnimated(o: THREE.Object3D, stopAt: THREE.Object3D): string | null {
  for (let cur: THREE.Object3D | null = o; cur; cur = cur.parent) {
    const ap = actionProfileOf(cur);
    if (!ap) {
      if (cur === stopAt) break;
      continue;
    }
    const role = ap.animationRole;
    if (typeof role === 'string' && role !== 'static') {
      return `role=${role}`;
    }
    const ch = ap.transformChannels as Record<string, unknown> | undefined;
    if (ch) {
      const moving = MOTION_CHANNELS.filter((k) => ch[k] === true);
      if (moving.length > 0) return `channels=${moving.join('+')}`;
    }
    if (cur === stopAt) break;
  }
  return null;
}

function materialIdOf(mat: THREE.Material): string {
  const id = (mat.userData?.sculptMaterial as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id ? id : '(anonymous)';
}

/** 从 o 到 stopAt（含）的对象链，o 在前 */
function chainTo(o: THREE.Object3D, stopAt: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (let cur: THREE.Object3D | null = o; cur; cur = cur.parent) {
    out.push(cur);
    if (cur === stopAt) break;
  }
  return out;
}

function renderable(o: THREE.Object3D, stopAt: THREE.Object3D): boolean {
  for (const node of chainTo(o, stopAt)) {
    if (!node.visible) return false;
  }
  return true;
}

function triangleCount(geo: THREE.BufferGeometry): number {
  if (geo.index) return geo.index.count / 3;
  const pos = geo.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

/** geometry 的属性集签名：属性不同不能拼（mergeGeometries 会返回 null） */
function attributeSignature(geo: THREE.BufferGeometry): string {
  return Object.keys(geo.attributes)
    .sort()
    .map((k) => {
      const attr = geo.getAttribute(k);
      return `${k}:${attr.itemSize}`;
    })
    .join('|');
}

export function batchMergeStatic(
  root: THREE.Object3D,
  opts: BatchMergeOptions = {}
): BatchMergeResult {
  const target = opts.mergeTarget ?? root;
  const respectAnim = opts.respectAnimationMetadata ?? true;
  const skipTransparent = opts.skipTransparent ?? true;
  const minGroupSize = opts.minGroupSize ?? 2;
  const disposeConsumed = opts.disposeConsumed ?? true;

  // 合并要靠 matrixWorld 烘焙几何体，先把祖先链到子孙链的世界矩阵刷一遍。
  // updateWorldMatrix(true, true) 而不是 updateMatrixWorld(true)：前者连带刷新祖先，
  // 否则在车已经跑起来之后再调用会拿到过期的父矩阵，位置整体偏移。
  root.updateWorldMatrix(true, true);

  // ---- 显式排除集合：对象及其整棵子树 ----
  const excluded = new Set<THREE.Object3D>();
  for (const obj of opts.excludeObjects ?? []) {
    obj.traverse((o) => excluded.add(o));
  }
  const patterns = [...DEFAULT_EXCLUDE_PATTERNS, ...(opts.excludePatterns ?? [])];
  const exactIds = new Set(opts.excludeIds ?? []);
  const uvContentIds = new Set(opts.excludeMaterialIds ?? UV_CONTENT_MATERIAL_IDS);

  // 合并前记录保护对象的父子链条，用于事后自校验
  const protectedChain = new Map<THREE.Object3D, THREE.Object3D | null>();
  for (const obj of opts.excludeObjects ?? []) {
    obj.traverse((o) => protectedChain.set(o, o.parent));
    protectedChain.set(obj, obj.parent);
  }

  const list: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) list.push(o as THREE.Mesh);
  });
  const meshesBefore = list.length;

  // ---- 分类：mergable vs skipped ----
  const skipped: SkippedMesh[] = [];
  interface Candidate {
    mesh: THREE.Mesh;
    material: THREE.Material;
    materialId: string;
  }
  const candidates: Candidate[] = [];
  const excludedIds = new Set<string>();

  const targetWorldInverse = new THREE.Matrix4().copy(target.matrixWorld).invert();

  for (const mesh of list) {
    const compId = componentIdOf(mesh) ?? mesh.name ?? '(unnamed)';
    const rawMat = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(rawMat)) {
      // 多材质 mesh 一组几何多个 group，合批语义完全不同，直接放弃
      skipped.push({ id: compId, materialId: '(multi)', reason: 'multi-material', detail: `${rawMat.length} materials` });
      continue;
    }
    const material = rawMat;
    const materialId = materialIdOf(material);

    const chain = chainTo(mesh, root);

    // 1) 显式排除（命中自身或任一祖先 → 整棵子树）
    let excludedBy: string | null = null;
    for (const node of chain) {
      if (excluded.has(node)) {
        excludedBy = componentIdOf(node) ?? node.name;
        break;
      }
    }
    if (excludedBy !== null) {
      const hits: string[] = [];
      mesh.traverse((o) => {
        const id = componentIdOf(o);
        if (id) hits.push(id);
      });
      for (const h of hits) excludedIds.add(h);
      skipped.push({ id: compId, materialId, reason: 'explicit-exclusion', detail: `子树受 ${excludedBy} 保护` });
      continue;
    }
    for (const node of chain) {
      const id = componentIdOf(node);
      if (!id) continue;
      if (exactIds.has(id) || patterns.some((p) => p.test(id))) {
        excludedBy = id;
        break;
      }
    }
    if (excludedBy !== null) {
      excludedIds.add(componentIdOf(mesh) ?? compId);
      skipped.push({ id: compId, materialId, reason: 'explicit-exclusion', detail: `ID 命中排除清单 ${excludedBy}` });
      continue;
    }

    // 2) spec metadata 声明可动
    if (respectAnim) {
      const anim = specSaysAnimated(mesh, root);
      if (anim) {
        skipped.push({ id: compId, materialId, reason: 'animated-in-spec', detail: anim });
        continue;
      }
    }

    // 3) 不可见件：本身占位、不占 draw call，合并进来反而可能把隐藏几何"显示"出去
    if (!renderable(mesh, root)) {
      skipped.push({ id: compId, materialId, reason: 'hidden', detail: '自身或祖先 visible=false' });
      continue;
    }

    // 4) 透明/透射：合批会让一组透明件失去逐件深度排序
    if (skipTransparent) {
      const rec = material as unknown as { transparent?: boolean; transmission?: number };
      const transp = rec.transparent === true || (rec.transmission ?? 0) > 0;
      if (transp) {
        skipped.push({ id: compId, materialId, reason: 'transparent', detail: `transparent=${rec.transparent} transmission=${rec.transmission ?? 0}` });
        continue;
      }
    }

    // 5) 内容型贴图材质（UI 画面 / 星空 / 灯箱点阵）：保留逐件 UV 语义，防御 runtime 换图
    if (uvContentIds.has(materialId)) {
      skipped.push({ id: compId, materialId, reason: 'uv-content-material', detail: '内容型贴图，不合批' });
      continue;
    }

    candidates.push({ mesh, material, materialId });
  }

  // ---- 按「材质实例」分组 ----
  // 用材质对象引用相等作为主键：材质实例不同，哪怕 sculptMaterial.id 相同也是两套 uniform / 贴图，
  // 绝不能合。同一实例的 id 用于报告。
  const materialIndex = new Map<THREE.Material, number>();
  interface Bucket {
    material: THREE.Material;
    materialId: string;
    items: Candidate[];
    cast: boolean;
    receive: boolean;
    order: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const c of candidates) {
    let idx = materialIndex.get(c.material);
    if (idx === undefined) {
      idx = materialIndex.size;
      materialIndex.set(c.material, idx);
    }
    const key = [
      idx,
      c.mesh.castShadow ? 1 : 0,
      c.mesh.receiveShadow ? 1 : 0,
      c.mesh.renderOrder,
      attributeSignature(c.mesh.geometry)
    ].join('|');
    let b = buckets.get(key);
    if (!b) {
      b = {
        material: c.material,
        materialId: c.materialId,
        items: [],
        cast: c.mesh.castShadow,
        receive: c.mesh.receiveShadow,
        order: c.mesh.renderOrder
      };
      buckets.set(key, b);
    }
    b.items.push(c);
  }

  // ---- 执行合并 ----
  const created: THREE.Mesh[] = [];
  const groups: BatchMergeGroup[] = [];
  const consumed = new Set<THREE.Mesh>();
  const targetRelative = new THREE.Matrix4();

  for (const b of buckets.values()) {
    if (b.items.length < minGroupSize) continue;
    const geos: THREE.BufferGeometry[] = [];
    for (const item of b.items) {
      // 把世界矩阵烘焙进几何体，并折算到合并目标父节点的局部空间
      targetRelative.multiplyMatrices(targetWorldInverse, item.mesh.matrixWorld);
      geos.push(item.mesh.geometry.clone().applyMatrix4(targetRelative));
    }
    let merged: THREE.BufferGeometry;
    try {
      merged = mergeSafe(geos);
    } catch (err) {
      // 合并失败不连累整车：这组保持原样
      for (const g of geos) g.dispose();
      for (const item of b.items) {
        skipped.push({
          id: componentIdOf(item.mesh) ?? item.mesh.name,
          materialId: b.materialId,
          reason: 'merge-failed',
          detail: err instanceof Error ? err.message : String(err)
        });
      }
      continue;
    }
    for (const g of geos) g.dispose(); // mergeSafe 已拷贝，中间体不再需要

    const mesh = new THREE.Mesh(merged, b.material);
    mesh.name = `batch/${b.materialId}`;
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    mesh.renderOrder = b.order;
    mesh.userData.batchMerged = {
      count: b.items.length,
      from: b.items.map((i) => componentIdOf(i.mesh) ?? i.mesh.name)
    };
    // 不写 userData.sculptComponent：避免后续 byId 索引把组件 ID 误指到合并件上
    target.add(mesh);
    created.push(mesh);

    for (const item of b.items) {
      consumed.add(item.mesh);
      item.mesh.removeFromParent();
    }

    groups.push({
      materialId: b.materialId,
      meshesIn: b.items.length,
      meshesOut: 1,
      triangles: triangleCount(merged)
    });
  }

  // ---- 释放被吞并掉的源几何体（只在没有别的 mesh 还在引用时）----
  if (disposeConsumed && consumed.size > 0) {
    const stillUsed = new Set<THREE.BufferGeometry>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (consumed.has(m)) return;
      stillUsed.add(m.geometry);
    });
    for (const mesh of consumed) {
      if (!stillUsed.has(mesh.geometry)) mesh.geometry.dispose();
    }
  }

  // ---- 自校验：保护对象必须还在场景图里，且父子关系未被改动 ----
  const problems: string[] = [];
  for (const obj of opts.excludeObjects ?? []) {
    const label = componentIdOf(obj) ?? obj.name ?? obj.type;
    if (consumed.has(obj as THREE.Mesh)) {
      problems.push(`保护对象 ${label} 被误合并`);
      continue;
    }
    let detached = false;
    let reparented = false;
    obj.traverse((o) => {
      if (!protectedChain.has(o)) return;
      if (o.parent !== protectedChain.get(o)) {
        if (o.parent === null) detached = true;
        else reparented = true;
      }
    });
    if (detached) problems.push(`保护对象 ${label} 的子树有节点脱离场景图`);
    else if (reparented) problems.push(`保护对象 ${label} 的子树有节点被重新挂载`);
  }

  // ---- 统计 ----
  let meshesAfter = 0;
  let drawAfter = 0;
  let trisAfter = 0;
  let drawBefore = 0;
  let trisBefore = 0;
  for (const m of list) {
    trisBefore += triangleCount(m.geometry);
    if (renderable(m, root)) drawBefore += 1;
  }
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshesAfter += 1;
    if (renderable(m, root)) {
      drawAfter += 1;
      trisAfter += triangleCount(m.geometry);
    }
  });

  return {
    meshesBefore,
    meshesAfter,
    drawCallsBefore: drawBefore,
    drawCallsAfter: drawAfter,
    drawCallReduction: drawBefore - drawAfter,
    trianglesBefore: trisBefore,
    trianglesAfter: trisAfter,
    groups,
    skipped,
    excludedIds: [...excludedIds].sort(),
    created,
    problems
  };
}
