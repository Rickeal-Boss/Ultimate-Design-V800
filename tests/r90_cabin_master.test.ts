/**
 * R90-5 · R7 内饰母版契约护栏（文件白名单：只写本文件；禁改 src/；禁 git commit/push）
 *
 * ═══ 本波修复的两个 P0 与本护栏的对应关系 ═══════════════════════════════════
 *  病根A（dev-cabin / R90-1 修）：assembleMasterCabin 里 `mesh.visible = false` 恒不渲染，
 *        R7Adapter.applyVisibility 旧版只写 root.visible ⇒ 母版永远看不见。
 *        修法方向：让 mesh.visible 也受 applyVisibility 接管（handle 必须暴露可写的
 *        mesh / mesh.visible）。本护栏 §2 钉死「handle.mesh 存在且 visible 可写」。
 *  病根B（主理人 + dev-cabin 真机实锤 / R90-2 修）：初稿假设「scale 4.323 放大成整车贴脸」
 *        **被推翻** —— 源 GLB 本身就是整车扫描（带车身/车门/车轮），scale 4.323 正确、
 *        相机在车内属正常。真病根是 translate：R89 (0.2,-0.25,-0.3) 让地板沉到 y=-0.25、
 *        座舱中心偏后 ⇒ 副驾侧围贴脸。修法：保留 scale=4.323，translate 改 (0.2,0.2,-0.1)
 *        （抬地板 + 前移，仪表台落在眼点前 ≈1.0m）。本护栏 §3 钉死「scale 不得缩小」+
 *        「translate 抬地板前移」；误缩到 s=2.20 的伪修复会被 §3① 拦下。
 *
 * ═══ 常量读取（R90 已落盘，保留动态 import 兼容后续调参）══════════════════════
 *  本文件一律用 **动态 import + 可选读取**：R90_CABIN_SCALE 若已落地则优先采用，
 *  未落地时用 R89_CABIN_SCALE 兜底。所有断言基于运行时真实导出。
 *
 * ═══ 断言强度（对齐 r81_regression.test.ts 口径）═══════════════════════════
 *  【强 · 真实执行级】vitest/node 下真跑纯函数：getMasterCabinAudit / assembleMasterCabin，
 *    用假 BufferGeometry（3 顶点 1 三角 / 源盒）断言审计账本、handle 契约、bbox 尺寸。
 *  【弱 · 源码字面量级】只读 InteriorCabinMaster.ts（git tracked）做结构锚点断言，
 *    钉死「单一 Mesh / 单一材质 / r44External 免纳管 / 不硬编码 mesh.visible」。
 *  ⚠ 纯函数护栏不发 fetch：inTestEnv() 在 MODE==='test' 下早退，本文件不调 loadMasterCabin。
 *  ⚠ 不读本机绝对路径；源码路径一律 import.meta.url 相对定位；sha/字符串 CRLF→LF 归一。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';

type CabinMod = typeof import('../src/model/external/InteriorCabinMaster');
type Audit = ReturnType<CabinMod['getMasterCabinAudit']>;

/** 动态 import：每次调用取运行时最新导出，兼容 dev-cabin 并行改盘。 */
async function loadCabinMod(): Promise<CabinMod> {
  return await import('../src/model/external/InteriorCabinMaster');
}

/** 可选读取数值型导出（R90 常量未落地时返回 undefined，不抛）。 */
function numExport(m: CabinMod, key: string): number | undefined {
  const v = (m as unknown as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * 声明的装配 scale：R90 若落地优先，否则 R89 兜底，最后常数 4.323 托底。
 * 4.323 只是「兜底的兜底」，与 R89_CABIN_SCALE 现值同源；不是本机路径。
 */
function declaredScale(m: CabinMod): number {
  return numExport(m, 'R90_CABIN_SCALE') ?? numExport(m, 'R89_CABIN_SCALE') ?? 4.323;
}

/** 假几何 A：3 顶点 / 1 三角（无 index ⇒ triangleCount=3/3=1）。 */
function makeTriGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ], 3));
  return g;
}

/** 假几何 B：源盒 size=(0.997,0.479,0.511)，用于病根B 装配后 world bbox 复算。 */
function makeSourceBox(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(0.997, 0.479, 0.511);
}

/** 读 geometry 装配后的 bbox 最长边（assembleMasterCabin 已 computeBoundingBox）。 */
function bboxLongest(g: THREE.BufferGeometry): number {
  if (!g.boundingBox) g.computeBoundingBox();
  const s = new THREE.Vector3();
  g.boundingBox!.getSize(s); // yaw=±π/2 只交换 x↔z 不影响最长边；translate 不改 size
  return Math.max(s.x, s.y, s.z);
}

/* ═══════ 0. 护栏自身纪律（弱 · 源码字面量级） ═══════ */

const ROOT = fileURLToPathSafe();
function fileURLToPathSafe(): string {
  // 不引 node:url 避免与 CJS 互操作差异；import.meta.url 在本仓库恒 file:// 绝对 URL
  return new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}
const MASTER_SRC_REL = 'src/model/external/InteriorCabinMaster.ts';

function readTracked(rel: string): string {
  const out = execFileSync('git', ['ls-files', '--', rel], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
  }).replace(/\r\n/g, '\n').trim();
  if (out !== rel) throw new Error(`[R90-5] 文件未入 git，CI 干净 checkout 会 ENOENT：${rel}`);
  return readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

describe('R90-5 · 0. 护栏自身纪律', () => {
  it('【弱】母版源文件已入库且可读（readFileSync 前先验 git ls-files）', () => {
    expect(readTracked(MASTER_SRC_REL).length).toBeGreaterThan(1000);
  });
});

/* ═══════ 1. 纯函数审计：null 安全值 + 假几何装配账本 ═══════ */

describe('R90-5 · 1. getMasterCabinAudit 纯函数护栏', () => {
  it('【强】getMasterCabinAudit(null/undefined) 返回全 0/false 安全值', async () => {
    const m = await loadCabinMod();
    const safe: Audit = {
      tri: 0, meshCount: 0, materialCount: 0, hasSculptId: false, isExternal: false
    };
    expect(m.getMasterCabinAudit(null)).toEqual(safe);
    expect(m.getMasterCabinAudit(undefined)).toEqual(safe);
  });

  it('【强】假几何（3 顶点 1 三角）装配审计 = 1 mesh / 1 材质 / 无 sculptId / external / tri=1', async () => {
    const m = await loadCabinMod();
    const handle = m.assembleMasterCabin(makeTriGeo());
    expect(handle.audit).toEqual({
      tri: 1, meshCount: 1, materialCount: 1, hasSculptId: false, isExternal: true
    });
    expect(handle.tri).toBe(1);
    // 契约常量（R90 若新增则优先，否则 R89）与装配账本的非 tri 字段一致
    const contract = ((m as unknown as Record<string, unknown>).R90_MASTER_CABIN_CONTRACT
      ?? m.R89_MASTER_CABIN_CONTRACT) as {
        meshCount: number; materialCount: number; hasSculptId: boolean; isExternal: boolean;
      };
    expect(contract.meshCount).toBe(handle.audit.meshCount);
    expect(contract.materialCount).toBe(handle.audit.materialCount);
    expect(contract.hasSculptId).toBe(handle.audit.hasSculptId);
    expect(contract.isExternal).toBe(handle.audit.isExternal);
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it('【强·护栏自检】材质带 sculptMaterial.id 时 audit.hasSculptId 翻真（非假绿）', async () => {
    const m = await loadCabinMod();
    const handle = m.assembleMasterCabin(makeTriGeo());
    expect(handle.audit.hasSculptId).toBe(false);
    (handle.material.userData as Record<string, unknown>).sculptMaterial = { id: 'r90-probe' };
    expect(m.getMasterCabinAudit(handle.root).hasSculptId).toBe(true);
  });

  it('【强】getMasterCabinAudit 只读不改入参（两次调用账本逐字段相同）', async () => {
    const m = await loadCabinMod();
    const handle = m.assembleMasterCabin(makeTriGeo());
    const before = { ...handle.audit };
    m.getMasterCabinAudit(handle.root);
    m.getMasterCabinAudit(handle.root);
    expect(handle.audit).toEqual(before);
    expect(handle.root.children).toHaveLength(1); // 遍历不增删子树
  });
});

/* ═══════ 2. 病根A 契约：handle.mesh 存在且 visible 可写 ═══════ */

describe('R90-5 · 2. 病根A 回归防护：mesh.visible 必须受控', () => {
  it('【强】装配 handle 暴露 mesh/root，且 mesh.visible 可读写（防「恒 false 无人覆盖」回归）', async () => {
    const m = await loadCabinMod();
    const handle = m.assembleMasterCabin(makeTriGeo());
    expect(handle.mesh).toBeDefined();
    expect(handle.root).toBeDefined();
    expect(handle.mesh).toBeInstanceOf(THREE.Mesh);
    expect(handle.root).toBeInstanceOf(THREE.Group);
    expect(handle.root.children).toContain(handle.mesh);
    // 关键：visible 必须是可写属性——applyVisibility 才能把它和 root 一起接管
    expect(() => { handle.mesh.visible = true; }).not.toThrow();
    expect(handle.mesh.visible).toBe(true);
    expect(() => { handle.mesh.visible = false; }).not.toThrow();
    expect(handle.mesh.visible).toBe(false);
  });

  it('【弱】源码装配出口存在且单一：只 new 一个 Mesh、r44External 免纳管标记保留', async () => {
    const src = readTracked(MASTER_SRC_REL);
    const fn = src.slice(src.indexOf('export function assembleMasterCabin('));
    expect(fn.length, 'assembleMasterCabin 切片失败').toBeGreaterThan(500);
    // 仍只有 1 个 Mesh 出口（1.5M tri 不按 1177 簇拆 Mesh）
    expect((fn.match(/new THREE\.Mesh\(/g) ?? []).length).toBe(1);
    // 子树免纳管标记必须保留（visible 唯一写入点 = applyVisibility）
    expect(src).toContain("r44External");
    // mesh 名兼容 R89/R90 两态（dev-cabin 重标定时可能同步改名，不钉死数字）
    expect(src).toMatch(/mesh\.name = 'r(?:89|90)-master-cabin'/);
  });
});

/* ═══════ 3. 病根B 契约：整车尺度必须保留，translate 决定座舱落位 ═══════
 * ⚠ 主理人 + dev-cabin 真机实锤（推翻本文件初稿的「scale 超标」假设）：
 *   interior-master.glb 是**带车身/车门/车轮的整车扫描**（1,499,982 tri 单 mesh），
 *   scale 4.323 与 manifest 同源是正确的整车尺度，相机落在 bbox 内属正常。
 *   误把 scale 缩到 2.20 反把整车变玩具壳包在相机外（实测 distToCenter 0.61m 仍在内部、
 *   门板更贴脸）。病根B 的真正变量是 **translate**：R89 (0.2,-0.25,-0.3) 让地板沉到
 *   y=-0.25、座舱中心偏后 ⇒ 副驾侧围贴脸；R90 (0.2,0.2,-0.1) 抬地板 + 前移 0.2m ⇒
 *   仪表台落在眼点前 ≈1.0m。护栏据此钉死「scale 不得缩小」+「translate 抬地板前移」。 */

describe('R90-5 · 3. 病根B 回归防护：整车 scale 保留 + translate 落位正确', () => {
  it('【强】装配 scale = 声明常量，且整车尺度不得被缩成玩具（防 s=2.20 伪修复回归）', async () => {
    const m = await loadCabinMod();
    const scale = declaredScale(m);
    const handle = m.assembleMasterCabin(makeSourceBox());
    const longest = bboxLongest(handle.mesh.geometry);
    const expectedLongest = 0.997 * scale; // yaw=±π/2 只交换 x/z，最长边恒 0.997*s
    expect(Math.abs(longest - expectedLongest) / expectedLongest,
      '装配 scale 与声明常量不同源').toBeLessThan(0.05);
    // 源是整车扫描 ⇒ 整车尺度必须保留；缩到 2.20（最长边 2.19m）会让车变玩具包相机
    expect(scale, '整车扫描件 scale 不得缩小（s=2.20 伪修复回归）').toBeGreaterThan(3.5);
    expect(longest, 'world bbox 最长边应保持整车量级 ≈4.31m').toBeGreaterThan(3.5);
  });

  it('【强】R90 translate 抬地板 + 前移：与 R89 病态值逐维背离，且地板不再沉地', async () => {
    const m = await loadCabinMod();
    const t = (m as unknown as Record<string, unknown>).R90_CABIN_TRANSLATE;
    expect(Array.isArray(t)).toBe(true);
    const tr = t as number[];
    expect(tr).toHaveLength(3);
    // R89 病态 (0.2,-0.25,-0.3)：地板 y=-0.25 沉地、中心 z=-0.3 偏后
    // R90 正确 (0.2,+0.2,-0.1)：地板抬到 y=0.2（>-0.25）、中心前移到 z=-0.1（>-0.3）
    expect(tr[1], '地板高度必须从 R89 的 -0.25 抬升（否则副驾侧围贴脸）').toBeGreaterThan(-0.25);
    expect(tr[2], '座舱中心必须从 R89 的 z=-0.3 前移（否则仪表台不在眼点前方）').toBeGreaterThan(-0.3);
  });

  it('【弱】scale/translate 为具名常量且变换链 yaw→scale→translate 顺序未被改坏', async () => {
    const src = readTracked(MASTER_SRC_REL);
    expect(src).toMatch(/(?:R89|R90)_CABIN_SCALE/);
    expect(src).toMatch(/(?:R89|R90)_CABIN_TRANSLATE/);
    const fn = src.slice(src.indexOf('export function assembleMasterCabin('),
      src.indexOf('// ② 源无 NORMAL'));
    expect(fn).toContain('geometry.rotateY(');
    expect(fn.indexOf('geometry.rotateY(')).toBeLessThan(fn.indexOf('geometry.scale('));
    expect(fn.indexOf('geometry.scale(')).toBeLessThan(fn.indexOf('geometry.translate('));
  });
});
