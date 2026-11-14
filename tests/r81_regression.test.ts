/**
 * R81 · 六文件热修回归网（Phase 4 测试线，文件白名单：只写本文件）
 *
 * ═══ 本波定罪与本护栏对应关系 ═════════════════════════════════════════════════
 *  P0-1 `src/util/geo.ts` + `src/model/parts/r7TailWrap.ts`
 *        R80 把 R7 侧贴默认关闭后 sideQuads=[]，仍无条件 mergeSafe(sideQuads)
 *        ⇒ mergeGeometries([]) 抛 TypeError ⇒ loadExternalShell catch ⇒ R66-D
 *        原子回滚 ⇒ 默认路径只剩 82 件程序化低模（用户「R7 无法进入」）。
 *        修：geo.ts 空数组早退返回空 BufferGeometry + r7TailWrap 默认分支
 *        彻底不建 sideGeo/sideMesh（双保险）。
 *  P0-2 `src/model/parts/tailLampC2.ts`
 *        R71 两处 side 循环（盖板侧面填充 / 侧面竖灯大面）共用同一顶点序
 *        ⇒ 叉积几何法线恒指局部 −X，FrontSide 只认绕序不认 normal 属性
 *        ⇒ body rotY(π) 后世界左侧那块被整块背面剔除（「只贴右侧」）。
 *        修：c2SideWindingIndex(side) 按 side 翻 index，position/uv/normal 逐位不动。
 *  P0-3 `src/model/roofCull.ts`
 *        R80 用 maxY > 阈值一刀切 ⇒ 全车上部 14.72% 三角（含 59,824 骨架）全被
 *        退化 ⇒ 骨架与星空顶边框一起消失。R81 二轮经 GLB 逐三角定量复核**重新定罪**：
 *        GLB 是单层薄壳、cabin 走 DoubleSide，「黑亮弧形面板」= 朝上车顶外表面的
 *        背面 ⇒ 正确靶点 = 车顶区(maxY 口径) && ny>0.5 朝上外表面（73,262 tri），
 *        骨架(|ny|<0.5) 与朝下内壁(ny<−0.5) 必须保留。
 *        ⚠ 派单一轮处方「minY 全过线 + 法线朝下」已被开发线 13:13:56 落盘推翻；
 *           本护栏按**最终落盘实现**断言（写盘竞态已记录 mtime 复核）。
 *  R81  `src/render/CameraRig.ts`
 *        撤销 R80 的 HOOD_Z −1.30 默认，恢复 R65-G8 用户真机确认基线 −1.45；
 *        −1.30 改由显式 `#r81hood=on` 启用。
 *  P1-5 `src/model/V800Adapter.ts`
 *        clearance = dist − 盘包围球半径；radius 为 NaN/0/Infinity 时 clearance
 *        非有限 ⇒ NaN 比较恒 false ⇒ 门控永久冻结远态 ⇒ 近平面黑面。
 *        修：装载 radius 有限性 + 物理区间 clamp；applySteerGate 对
 *        dist/clearance 做有限性保护，非有限保持当前态；滞回 0.16/0.26 不变。
 *
 * ═══ 断言强度分层（主理人 D 项要求逐条标注）═════════════════════════════════
 *  【强 · 真实执行级】直接 import 纯函数 / builder / CameraRig，在 node 下真跑：
 *    · mergeSafe([]) 不抛 + 返回空 BufferGeometry（§1）
 *    · buildR7TailWrap 默认分支不抛 + 3 mesh / 3 geo / 3 DC（§1，端到端堵 P0-1）
 *    · c2SideWindingIndex + 叉积实算 + builder 真实几何法线朝外（§2）
 *    · buildRoofCulledIndex 手工 BufferGeometry 幂等 / 骨架保留 / A-B 回滚（§3）
 *    · CameraRig hood 默认机位 z = −1.45（§4）
 *  【弱 · 源码字面量级】只读 git tracked 源码做正则 / 结构断言：
 *    开关名、回滚钩子、滞回常量、clamp 形态、#hoodcam 扫参正则等（§1~§5）。
 *
 * ⚠ 纪律（历史 CI BLOCKER）：readFileSync 前一律 execFileSync('git',['ls-files','--',p])
 *   验入库；绝不读 .qa/ dist/ tools/ 未入库文件 / 本机绝对路径。
 *   sha / 源码字符串一律 CRLF→LF 归一。CI 无 WebGL / 无真实 Canvas ⇒ 不读渲染后
 *   像素，只做纯字符串 / 纯数值（叉积、Uint32Array 逐位）断言；画面判据交审查线。
 * ⚠ 不放宽任何既有断言、不删断言；本文件纯新增。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { mergeSafe } from '../src/util/geo';
import { buildR7TailWrap } from '../src/model/parts/r7TailWrap';
import {
  buildTailLampC2,
  c2SideWindingIndex,
  R81_C2_SIDE_WINDING_ON,
  R69_C2_LAMP_ON,
  R71_C2_SIDE_ON,
  R71_C2_COVERFILL_ON,
  C2_GEOM,
  C2_LAMP_SIDE_DEPTH,
  C2_COVER_FILL_DEPTH
} from '../src/model/parts/tailLampC2';
import { buildRoofCulledIndex, ROOF_CULL_HORIZONTAL_NY } from '../src/model/roofCull';
import { CameraRig } from '../src/render/CameraRig';

/* ═══════════════ helpers（全部内联，零未入库依赖） ═══════════════ */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 只读白名单：本波 6 个生产源码，全部已 git tracked（CI 干净 checkout 不会 ENOENT）。 */
const TRACKED = [
  'src/util/geo.ts',
  'src/model/parts/r7TailWrap.ts',
  'src/model/parts/tailLampC2.ts',
  'src/model/roofCull.ts',
  'src/model/V800Adapter.ts',
  'src/render/CameraRig.ts'
] as const;

function lsFiles(p: string): string {
  try {
    return execFileSync('git', ['ls-files', '--', p], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).replace(/\r\n/g, '\n').trim();
  } catch {
    throw new Error(`[R81] git ls-files 不可用，无法验证入库状态：${p}`);
  }
}

/** readFileSync 前必先验入库（R64-fix / R67-CI-fix 两次 ENOENT 同款铁律）。 */
function assertTracked(p: string): void {
  if (lsFiles(p) !== p) throw new Error(`[R81] 文件未入 git，CI 干净 checkout 会 ENOENT：${p}`);
}

const src = (p: string): string => {
  assertTracked(p);
  return readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
};

/** 与 r59/r68 同源的锚点切片（找不到锚点返回空串，不静默误切）。 */
const slice = (s: string, from: string, to: string): string => {
  const a = s.indexOf(from);
  const b = a < 0 ? -1 : s.indexOf(to, a);
  return a < 0 || b < 0 ? '' : s.slice(a, b);
};

const geo = src('src/util/geo.ts');
const wrap = src('src/model/parts/r7TailWrap.ts');
const c2 = src('src/model/parts/tailLampC2.ts');
const roof = src('src/model/roofCull.ts');
const adapter = src('src/model/V800Adapter.ts');
const rig = src('src/render/CameraRig.ts');

/* ═══════ 0. 护栏自身纪律（弱 · 源码字面量级） ═══════ */

describe('R81 · 0. 只读 git tracked 铁律', () => {
  it('6 个 readFileSync 目标全部已入库（逐个 git ls-files）', () => {
    for (const p of TRACKED) expect(lsFiles(p), `${p} 未入库`).toBe(p);
  });

  it('源码读取一律 LF 归一（不含 CRLF），且 6 个文件互不为空', () => {
    for (const s of [geo, wrap, c2, roof, adapter, rig]) {
      expect(s.length).toBeGreaterThan(100);
      expect(s.includes('\r\n')).toBe(false);
    }
  });
});

/* ═══════ 1. P0-1 · 默认路径加载守卫（本波最高杠杆） ═══════ */

describe('R81 · 1. P0-1 默认路径加载：mergeSafe 空数组 + R7 默认分支不建空 sideGeo', () => {
  it('【强】mergeSafe([]) 不抛 TypeError，返回空 BufferGeometry（真跑纯函数）', () => {
    let g: THREE.BufferGeometry | undefined;
    expect(() => { g = mergeSafe([]); }).not.toThrow();
    expect(g).toBeInstanceOf(THREE.BufferGeometry);
    // 空几何：无 position / 无 index（不是「带一个 0 顶点属性」的伪空体）
    expect(g!.getAttribute('position')).toBeUndefined();
    expect(g!.getIndex()).toBeNull();
  });

  it('【强】mergeSafe 非空入参行为不回退：2 个 quad 仍合出 12 顶点 / 4 tri', () => {
    const q = (x: number): THREE.BufferGeometry => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([
        x, 1, 0, x + 1, 1, 0, x, 0, 0, x + 1, 0, 0
      ], 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([
        0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1
      ], 3));
      g.setIndex([0, 1, 2, 1, 3, 2]);
      return g;
    };
    const a = q(0), b = q(2);
    const merged = mergeSafe([a, b]);
    // mergeSafe 统一 toNonIndexed ⇒ indexed quad 4 顶点扩成 6 顶点，2 个 = 12
    expect(merged.getAttribute('position').count).toBe(12);
    expect(merged.getIndex()).toBeNull();
    a.dispose(); b.dispose(); merged.dispose();
  });

  it('【强·端到端】buildR7TailWrap 默认分支（node 无 window）不抛、恒 3 mesh / 3 geo / 3 DC', () => {
    const result = buildR7TailWrap({
      scale: 4.323,
      bodyMaxZ: 2.5194,
      bodyHalfWidth: 1.1127,
      lampRearMat: new THREE.MeshStandardMaterial()
    });
    // 默认 R81_R7_SIDE_SKIP=true / R80_R7_SIDE_ON=false ⇒ 不进侧贴分支
    expect(result.meshes).toHaveLength(3);
    expect(result.geos).toHaveLength(3);
    expect(result.budget.dc).toBe(3);
    expect(result.meshes.some((m) => m.name === 'r68_r7_tail_side')).toBe(false);
    // geos 数组不含空体：每个几何都带非空 position（P0-1「geos 分支不含空体」）
    for (const g of result.geos) {
      expect(g.getAttribute('position').count).toBeGreaterThan(0);
    }
    // 3 个装配 mesh 名称逐字钉死（防有人把 sideMesh 混进默认出口）
    expect(result.meshes.map((m) => m.name)).toEqual([
      'r68_r7_tail_modules', 'r68_r7_tail_edge', 'r68_r7_tail_band'
    ]);
  });

  it('【弱】geo.ts 含空数组早退 + guard 开关 + #r81mergeempty=off 回滚钩子', () => {
    expect(geo).toContain('export function mergeSafe(geos: THREE.BufferGeometry[])');
    expect(geo).toMatch(/if \(R81_MERGE_EMPTY_GUARD && geos\.length === 0\) return new THREE\.BufferGeometry\(\);/);
    expect(geo).toContain('const R81_MERGE_EMPTY_GUARD: boolean =');
    expect(geo).toContain('r81mergeempty=off');
    // 早退必须在 normalized / mergeGeometries 之前（否则空数组仍会进 three 内部炸）
    expect(geo.indexOf('geos.length === 0')).toBeLessThan(geo.indexOf('mergeGeometries(normalized)'));
  });

  it('【弱】r7TailWrap.ts 结构：sideGeo/sideMesh 默认 null，mergeSafe(sideQuads) 只在侧贴分支内', () => {
    const fn = slice(wrap, 'export function buildR7TailWrap(', '\n}');
    expect(fn.length, 'buildR7TailWrap 函数体切片失败').toBeGreaterThan(500);
    // 默认不建：两个句柄初值都是 null（不是无条件 new Mesh）
    expect(fn).toContain('let sideGeo: THREE.BufferGeometry | null = null;');
    expect(fn).toContain('let sideMesh: THREE.Mesh | null = null;');
    // 侧贴分支门控存在，且 sideQuads / mergeSafe(sideQuads) 都落在分支内
    const gate = 'if (R80_R7_SIDE_ON || !R81_R7_SIDE_SKIP) {';
    const gateAt = fn.indexOf(gate);
    expect(gateAt, 'R81 侧贴门控缺失').toBeGreaterThanOrEqual(0);
    expect(fn).toContain('const R81_R7_SIDE_SKIP: boolean =');
    expect(fn).toContain('r81r7sideskip=off');
    expect(fn.indexOf('const sideQuads: THREE.BufferGeometry[] = []')).toBeGreaterThan(gateAt);
    // ⚠ 只认「赋值语句形态」：函数头注释里也有 `mergeSafe(sideQuads)`（R80 定罪说明），
    //   用裸串 indexOf 会命中注释（实测 3003 < gateAt 3869）⇒ 假红，故钉完整赋值语句。
    expect(fn.indexOf('sideGeo = mergeSafe(sideQuads);')).toBeGreaterThan(gateAt);
    // 分支外不得再出现无条件合并调用（R80 P0 原形）；注释中的提及不计入
    expect(fn.split('sideGeo = mergeSafe(sideQuads);')).toHaveLength(2);
    // geos 账本用三元排除空体；meshes 基础 3 个 + 条件 push
    expect(fn).toContain('geos: sideGeo');
    expect(fn).toContain('? [moduleGeo, edgeGeo, bandGeo, sideGeo]');
    expect(fn).toContain(': [moduleGeo, edgeGeo, bandGeo]');
    expect(fn).toContain('const meshes: THREE.Mesh[] = [moduleMesh, edgeMesh, bandMesh];');
    expect(fn).toContain('if (R80_R7_SIDE_ON && sideMesh) meshes.push(sideMesh);');
    expect(fn).toContain('dc: meshes.length');
  });
});

/* ═══════ 2. P0-2 · C2 左右对称守卫 ═══════ */

interface XPlaneTri { x: number; nx: number; }

/**
 * 取几何里「三顶点 x 全等」的侧面三角，返回其 x 与叉积法线 x 分量。
 * indexed / non-indexed 双兼容（mergeSafe 产物恒 non-indexed）。
 * 叉积 (b−a)×(c−a) 的 x 分量 = e1.y*e2.z − e1.z*e2.y —— GPU FrontSide
 * 背面剔除只看绕序，不看 normal 属性，故这才是「几何法线」的真值。
 */
function xPlaneTris(g: THREE.BufferGeometry, eps = 1e-6): XPlaneTri[] {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  const out: XPlaneTri[] = [];
  const get = (k: number): readonly [number, number, number] => {
    const i = idx ? idx.getX(k) : k;
    return [pos.getX(i), pos.getY(i), pos.getZ(i)] as const;
  };
  for (let t = 0; t + 2 < n; t += 3) {
    const a = get(t), b = get(t + 1), c = get(t + 2);
    if (Math.abs(a[0] - b[0]) > eps || Math.abs(a[0] - c[0]) > eps) continue;
    const e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2y = c[1] - a[1], e2z = c[2] - a[2];
    const nx = e1y * e2z - e1z * e2y;
    if (Math.abs(nx) < 1e-12) continue; // 零面积退化三角
    out.push({ x: a[0], nx });
  }
  return out;
}

/** 与 tailLampC2.ts 两处 side 循环同源的 quad 顶点（zIn = zOut + depth，depth>0）。 */
function quadVerts(x: number, depth: number): readonly (readonly [number, number, number])[] {
  const yLo = 0, yHi = 1, zOut = 0, zIn = zOut + depth;
  return [
    [x, yLo, zIn], [x, yHi, zIn], [x, yLo, zOut], [x, yHi, zOut]
  ] as const;
}

/** 用给定 index 组装三角并算几何法线 x 分量（叉积实算）。 */
function quadNormalX(order: number[], x: number, depth: number): number[] {
  const v = quadVerts(x, depth);
  const out: number[] = [];
  for (let t = 0; t + 2 < order.length; t += 3) {
    const a = v[order[t]], b = v[order[t + 1]], c = v[order[t + 2]];
    const e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2y = c[1] - a[1], e2z = c[2] - a[2];
    out.push(e1y * e2z - e1z * e2y);
  }
  return out;
}

describe('R81 · 2. P0-2 C2 左右对称：quad 几何法线分别朝局部 ±X', () => {
  it('【强】c2SideWindingIndex 按 side 分支：−1 与 +1 的 index 不同且逐字等于 R81 两态', () => {
    expect(R81_C2_SIDE_WINDING_ON, 'node 无 window ⇒ 默认 ON（护栏前提）').toBe(true);
    expect(c2SideWindingIndex(-1)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(c2SideWindingIndex(1)).toEqual([0, 2, 1, 1, 2, 3]);
    expect(c2SideWindingIndex(-1)).not.toEqual(c2SideWindingIndex(1));
  });

  it('【强·叉积实算】side=−1 两个三角 nx<0；side=+1 两个三角 nx>0（R71 旧绕序两侧恒 −X）', () => {
    for (const depth of [C2_COVER_FILL_DEPTH, C2_LAMP_SIDE_DEPTH]) {
      expect(depth).toBeGreaterThan(0);
      const neg = quadNormalX(c2SideWindingIndex(-1), -0.2, depth);
      const pos = quadNormalX(c2SideWindingIndex(1), 0.2, depth);
      expect(neg).toHaveLength(2);
      expect(pos).toHaveLength(2);
      for (const nx of neg) expect(nx, `depth=${depth} side=−1 三角法线应指 −X`).toBeLessThan(0);
      for (const nx of pos) expect(nx, `depth=${depth} side=+1 三角法线应指 +X`).toBeGreaterThan(0);
      // 定罪对照：若两侧都写回同一套旧绕序，+X 侧必为负 ⇒ 单侧被背面剔除
      const broken = quadNormalX([0, 1, 2, 1, 3, 2], 0.2, depth);
      for (const nx of broken) expect(nx).toBeLessThan(0);
    }
  });

  it('【强·builder 真实几何】coverMesh / faceMesh 所有 ±X 平面三角法线朝外（nx 与 x 同号）', () => {
    // node 下三个 hook 默认 ON ⇒ 两处 side quad 都会真实产出
    expect(R69_C2_LAMP_ON).toBe(true);
    expect(R71_C2_SIDE_ON).toBe(true);
    expect(R71_C2_COVERFILL_ON).toBe(true);
    const r = buildTailLampC2({ scale: 4.75, lampRearMat: new THREE.MeshStandardMaterial() });
    for (const [label, g] of [
      ['coverMesh', r.coverMesh.geometry],
      ['faceMesh', r.faceMesh.geometry]
    ] as const) {
      const tris = xPlaneTris(g);
      expect(tris.length, `${label} 未筛到任何 ±X 平面三角（护栏空集假绿）`).toBeGreaterThan(0);
      expect(tris.some((t) => t.x < 0), `${label} 缺局部 −X 侧三角`).toBe(true);
      expect(tris.some((t) => t.x > 0), `${label} 缺局部 +X 侧三角`).toBe(true);
      for (const t of tris) {
        expect(
          Math.sign(t.nx),
          `${label} x=${t.x.toFixed(5)} 的三角几何法线 nx=${t.nx.toFixed(6)} 必须朝外`
        ).toBe(Math.sign(t.x));
      }
    }
  });

  it('【弱】tailLampC2.ts 两处 side 循环改用 c2SideWindingIndex(side)，不再写死同一套顶点序', () => {
    expect(c2).toContain('export const R81_C2_SIDE_WINDING_ON = !r69HookOff(\'r81c2side\');');
    expect(c2).toContain('export function c2SideWindingIndex(side: number): number[] {');
    expect(c2).toContain('? [0, 2, 1, 1, 2, 3]');
    expect(c2).toContain(': [0, 1, 2, 1, 3, 2];');
    expect(c2).toContain('r81c2side=off');
    // 两处调用点（盖板侧面填充 / 侧面竖灯大面），一处都不能漏
    expect(c2.match(/setIndex\(c2SideWindingIndex\(side\)\)/g) ?? []).toHaveLength(2);
    const fill = slice(c2, 'if (R71_C2_COVERFILL_ON) {', 'const coverMesh =');
    const side = slice(c2, 'const faceQuads: THREE.BufferGeometry[] = [];', 'const faceGeo =');
    expect(fill).toContain('for (const side of [-1, 1])');
    expect(fill).toContain('setIndex(c2SideWindingIndex(side))');
    expect(side).toContain('for (const side of [-1, 1])');
    expect(side).toContain('setIndex(c2SideWindingIndex(side))');
    // 两处循环体内不得残留写死 index（正面 makeQuad 的写死 index 不在此切片内）
    expect(fill).not.toContain('setIndex([0, 1, 2, 1, 3, 2])');
    expect(side).not.toContain('setIndex([0, 1, 2, 1, 3, 2])');
    // 只翻 index ⇒ position/uv/normal 数据逐位不动（凤凰点阵不镜像）
    expect(c2).toContain('remapUVToRegion(sq, side < 0 ? 0 : 0.5, side < 0 ? 0.5 : 1, 0, 1);');
    expect(C2_GEOM.faceZ).toBeLessThan(C2_GEOM.coverZ); // C2_GEOM 全字段未被本波改动
  });
});

/* ═══════ 3. P0-3 · 车顶剔除幂等守卫（纯函数真实执行） ═══════ */

/**
 * 手工构造 6 三角的小 BufferGeometry（Uint32 index + position + normal）。
 * roofLocal = roofWorldY/scale = 1.0（scale=1, roofWorldY=1.0）。
 *
 * ⚠ 判据按 **R81 二轮最终落盘实现**（13:13:56 重写，推翻派单一轮处方）：
 *   有 normal ⇒ hit = region(max y > roofLocal) && upward(ny > 0.5) && horizontal(|ny|>=0.5)
 *   即「车顶区 + 朝上外表面」，**朝下内壁(ny<-0.5) 与骨架(|ny|<0.5) 必须保留**。
 *   （派单描述的「min y + 法线朝下」是一轮处方，已由开发线定量复核推翻。）
 *
 *   T0 整片朝上车顶外表面 y 全 1.2  ny=+1 ⇒ 命中
 *   T1 跨阈值竖直骨架     y[0.8,1.3,0.9] ny=0  ⇒ 保留（骨架）
 *   T2 低处侧壁           y 全 0.5  ny=+1 ⇒ 不过线，保留
 *   T3 高处朝下内壁       y 全 1.4  ny=−1 ⇒ 保留（二轮定罪核心：内壁不能剔）
 *   T4 高处朝上外表面     y 全 1.5  ny=+1 ⇒ 命中
 *   T5 跨阈值但朝上外表面 y[0.8,1.3,0.9] ny=+1 ⇒ 命中（证明 region 用 maxY 而非 minY）
 */
function makeRoofGeo(withNormal: boolean): { g: THREE.BufferGeometry; src: Uint32Array } {
  const g = new THREE.BufferGeometry();
  const y = [
    1.2, 1.2, 1.2, 0.8, 1.3, 0.9, 0.5, 0.5, 0.5,
    1.4, 1.4, 1.4, 1.5, 1.5, 1.5, 0.8, 1.3, 0.9
  ];
  const ny = [
    1, 1, 1, 0, 0, 0, 1, 1, 1,
    -1, -1, -1, 1, 1, 1, 1, 1, 1
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  for (let i = 0; i < y.length; i += 1) {
    pos.push((i % 3) * 0.4, y[i], Math.floor(i / 3) * 0.3);
    nrm.push(0, ny[i], 0);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (withNormal) g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  const arr = new Uint32Array(y.length);
  for (let i = 0; i < y.length; i += 1) arr[i] = i;
  // 显式 Uint32Array：three 的 setIndex(number[]) 会按顶点数降到 Uint16 ⇒ 不满足纯函数入口判据
  g.setIndex(new THREE.BufferAttribute(arr, 1));
  return { g, src: arr };
}

describe('R81 · 3. P0-3 buildRoofCulledIndex 幂等 / 骨架与内壁保留 / A-B 回滚', () => {
  it('【强】full 逐位等于原 index；culled 只退化 T0/T4/T5；roofTris 计数精确', () => {
    const { g, src: arr } = makeRoofGeo(true);
    const r = buildRoofCulledIndex(g, 1, 1.0);
    expect(r, 'Uint32 index + position 齐全 ⇒ 不得返回 null').not.toBeNull();
    expect(r!.totalTris).toBe(6);
    expect(Array.from(r!.full)).toEqual(Array.from(arr));
    expect(r!.roofTris).toBe(3);
    // 命中三角（朝上车顶外表面）三索引全置 0
    for (const [lo, hi] of [[0, 3], [12, 15], [15, 18]] as const) {
      expect(Array.from(r!.culled.slice(lo, hi))).toEqual([0, 0, 0]);
    }
    // 未命中三角在 culled 里逐位保留（骨架 T1 / 低处 T2 / 朝下内壁 T3）
    for (const [lo, hi] of [[3, 6], [6, 9], [9, 12]] as const) {
      expect(Array.from(r!.culled.slice(lo, hi))).toEqual(Array.from(arr.slice(lo, hi)));
    }
  });

  it('【强·二轮定罪核心】朝下内壁 T3 与跨阈值竖直骨架 T1 均不被剔', () => {
    const { g, src: arr } = makeRoofGeo(true);
    const r = buildRoofCulledIndex(g, 1, 1.0)!;
    // T1：maxY=1.3 > 1.0 但 ny=0（非朝上外表面）⇒ 骨架必须回来
    expect(Array.from(r.culled.slice(3, 6)), '跨阈值骨架 T1 被误剔').toEqual(Array.from(arr.slice(3, 6)));
    // T3：y 全 1.4 过线但 ny=−1（朝下内壁）⇒ 二轮明确要求保留
    expect(Array.from(r.culled.slice(9, 12)), '朝下内壁 T3 被误剔').toEqual(Array.from(arr.slice(9, 12)));
    // 对照：T5 跨阈值（minY=0.8<1.0）但 ny=+1 朝上 ⇒ 命中，证明 region 用 maxY 口径
    expect(Array.from(r.culled.slice(15, 18))).toEqual([0, 0, 0]);
  });

  it('【强】mode=\'r80\' 逐位回 R80 maxY 判据（A/B 回滚契约）', () => {
    const { g } = makeRoofGeo(true);
    const r80 = buildRoofCulledIndex(g, 1, 1.0, 'r80')!;
    // maxY > 1.0 ⇒ 除 T2(0.5) 外 5 个三角全剔（含骨架 / 内壁）⇒ 复现「骨架消失」
    expect(r80.roofTris).toBe(5);
    expect(Array.from(r80.culled.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(r80.culled.slice(3, 6))).toEqual([0, 0, 0]);
    expect(Array.from(r80.culled.slice(6, 9))).toEqual([6, 7, 8]);
    expect(Array.from(r80.culled.slice(9, 12))).toEqual([0, 0, 0]);
    expect(Array.from(r80.culled.slice(12, 15))).toEqual([0, 0, 0]);
    expect(Array.from(r80.culled.slice(15, 18))).toEqual([0, 0, 0]);
    // 显式 r81 与默认参数逐位一致（默认态就是新判据）
    const rDefault = buildRoofCulledIndex(g, 1, 1.0)!;
    const rExplicit = buildRoofCulledIndex(g, 1, 1.0, 'r81')!;
    expect(Array.from(rExplicit.culled)).toEqual(Array.from(rDefault.culled));
  });

  it('【强】无 normal 属性不抛 / 不返回 null，退化为只按 minY（骨架 T1/T5 仍保留）', () => {
    const { g } = makeRoofGeo(false);
    let r: ReturnType<typeof buildRoofCulledIndex> = null;
    expect(() => { r = buildRoofCulledIndex(g, 1, 1.0); }).not.toThrow();
    expect(r).not.toBeNull();
    expect(Array.from(r!.full)).toEqual(Array.from(new Uint32Array(18).map((_, i) => i)));
    // 无 normal ⇒ horizontal 恒 true，只按 minY：T0/T3/T4 剔（3 个）；
    // T1 / T5 跨阈值、T2 低处保留（保守退化带，骨架不误伤）
    expect(r!.roofTris).toBe(3);
    expect(Array.from(r!.culled.slice(3, 6)), '无 normal 时跨阈值骨架 T1 不得被剔').toEqual([3, 4, 5]);
    expect(Array.from(r!.culled.slice(6, 9))).toEqual([6, 7, 8]);
    expect(Array.from(r!.culled.slice(15, 18)), '无 normal 时跨阈值骨架 T5 不得被剔')
      .toEqual([15, 16, 17]);
  });

  it('【强】幂等：连续两次调用 full/culled/roofTris 逐位相同，且不改写入参 geometry', () => {
    const { g, src: arr } = makeRoofGeo(true);
    const a = buildRoofCulledIndex(g, 1, 1.0)!;
    const b = buildRoofCulledIndex(g, 1, 1.0)!;
    expect(Array.from(b.full)).toEqual(Array.from(a.full));
    expect(Array.from(b.culled)).toEqual(Array.from(a.culled));
    expect(b.roofTris).toBe(a.roofTris);
    // 纯函数：原 index 数组未被就地写 0
    expect(Array.from(g.getIndex()!.array as Uint32Array)).toEqual(Array.from(arr));
    expect(g.getIndex()!.array).not.toBe(a.culled);
    expect(g.getIndex()!.array).not.toBe(a.full);
  });

  it('【强】非 Uint32 index 返回 null（调用方跳过剔除，等同关闭）', () => {
    const { g } = makeRoofGeo(true);
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(18).map((_, i) => i), 1));
    expect(buildRoofCulledIndex(g, 1, 1.0)).toBeNull();
  });

  it('【强·单向判据核心】同高度、仅 ny 符号相反：朝下内壁保留、朝上外表面剔除', () => {
    // 主理人 13:39 明确要求：钉死「只剔朝上(ny>0.5)、不剔朝下(ny<−0.5)」，
    // 防止有人把单向判据改回双向 |ny|>=0.5 ⇒ 朝下内壁被误剔、黑亮面板复发。
    // 两个三角 y 完全相同（排除 y 差异干扰），只在 normal.y 符号上不同。
    const g = new THREE.BufferGeometry();
    const pos: number[] = [], nrm: number[] = [];
    const y = 1.2; // 两三角同高度且均过线 roofLocal=1.0
    // T0 ny=−1（朝下内壁）/ T1 ny=+1（朝上外表面）
    for (const ny of [-1, 1]) {
      for (let k = 0; k < 3; k += 1) {
        pos.push(k * 0.4, y, k * 0.3);
        nrm.push(0, ny, 0);
      }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    const arr = new Uint32Array([0, 1, 2, 3, 4, 5]);
    g.setIndex(new THREE.BufferAttribute(arr, 1));

    const r = buildRoofCulledIndex(g, 1, 1.0)!;
    expect(r.totalTris).toBe(2);
    // 朝下内壁：逐位保留（不是 [0,0,0]）
    expect(Array.from(r.culled.slice(0, 3)), 'ny=−1 朝下内壁被误剔 ⇒ 单向判据被改成双向')
      .toEqual([0, 1, 2]);
    // 朝上外表面：三索引置 0
    expect(Array.from(r.culled.slice(3, 6)), 'ny=+1 朝上外表面应被剔').toEqual([0, 0, 0]);
    expect(r.roofTris).toBe(1);
    expect(Array.from(r.full)).toEqual(Array.from(arr));
    // 对照：双向判据 |ny|>=0.5 会把两个都剔（roofTris=2）⇒ 本断言能拦住该回退
    // （此处不实现双向，仅作语义说明；r80 一刀切仍逐位回 maxY）
    const r80 = buildRoofCulledIndex(g, 1, 1.0, 'r80')!;
    expect(r80.roofTris).toBe(2);
  });

  it('【强·R7 逃生门运行时】#r81r7roofcull=off ⇒ 3 参默认 mode 逐位等价于显式 r80', async () => {
    // 审查线 Phase 3 终裁指出的护栏缺口：R81_ROOF_CULL_DEFAULT_MODE 是**模块求值期**
    // 读 window，Node/SSR 无 window 恒 'r81'，真机带钩子是 'r80'。此前护栏只钉常量
    // 字符串 + 显式 mode='r80' 调用，未覆盖「求值期开关改变默认 mode」这一真实行为。
    // 这里用 stubGlobal + resetModules 重新求值模块，做运行时逐位等价验证。
    const { g } = makeRoofGeo(true);
    const clean = await import('../src/model/roofCull');
    const r81 = clean.buildRoofCulledIndex(g, 1, 1.0, 'r81')!;
    const r80 = clean.buildRoofCulledIndex(g, 1, 1.0, 'r80')!;
    // 前置：两态必须确有差异，否则本断言会假绿
    expect(Array.from(r81.culled)).not.toEqual(Array.from(r80.culled));

    vi.stubGlobal('window', { location: { hash: '#r81r7roofcull=off' } });
    try {
      vi.resetModules();
      const hooked = await import('../src/model/roofCull');
      // 3 参调用（R7Adapter 两处同款）⇒ 继承求值期默认 mode，应为 'r80'
      const rHooked = hooked.buildRoofCulledIndex(g, 1, 1.0)!;
      expect(Array.from(rHooked.culled), '逃生门态 3 参默认应逐位回 r80')
        .toEqual(Array.from(r80.culled));
      expect(rHooked.roofTris).toBe(r80.roofTris);
      expect(Array.from(rHooked.full)).toEqual(Array.from(r81.full)); // full 恒逐位拷贝
      // V800Adapter 始终显式传 R81_ROOF_CULL_MODE ⇒ 不受逃生门影响
      const rHookedExplicit = hooked.buildRoofCulledIndex(g, 1, 1.0, 'r81')!;
      expect(Array.from(rHookedExplicit.culled), '显式 mode 必须能覆盖逃生门默认值')
        .toEqual(Array.from(r81.culled));
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('【强·两态分离】有 normal 单向判据 vs 无 normal minY 退化：culled 逐位不同', () => {
    // 审查线要求「线上 GLB 有 NORMAL，不走无 normal 退化分支，请分别覆盖两态」。
    // 两态各自已有独立 it（见上：有 normal 的 §3 主断言 / 无 normal 退化 it），
    // 这里再做一次**同几何对照**，证明它们确实是两套判据而非同一实现，
    // 防止有人把退化分支悄悄改成与单向判据相同（或反之）。
    const gWith = makeRoofGeo(true).g;
    const gWithout = makeRoofGeo(false).g;
    const withN = buildRoofCulledIndex(gWith, 1, 1.0)!;
    const withoutN = buildRoofCulledIndex(gWithout, 1, 1.0)!;
    expect(withN.totalTris).toBe(withoutN.totalTris);
    expect(Array.from(withN.full)).toEqual(Array.from(withoutN.full));
    expect(Array.from(withN.culled)).not.toEqual(Array.from(withoutN.culled));
    // 有 normal：只剔朝上（T0/T4/T5）⇒ 朝下内壁 T3 保留
    expect(Array.from(withN.culled.slice(9, 12))).toEqual([9, 10, 11]);
    // 无 normal：只按 minY ⇒ 高过线的 T3 被剔、跨阈值 T5 保留
    expect(Array.from(withoutN.culled.slice(9, 12))).toEqual([0, 0, 0]);
    expect(Array.from(withoutN.culled.slice(15, 18))).toEqual([15, 16, 17]);
  });

  it('【弱】roofCull.ts 二轮判据字面量：车顶区 maxY + 朝上外表面 + mode 分支 + 缺省 normal', () => {
    expect(roof).toContain("export type RoofCullMode = 'r81' | 'r80';");
    expect(roof).toContain('export const ROOF_CULL_HORIZONTAL_NY = 0.5;');
    expect(ROOF_CULL_HORIZONTAL_NY).toBe(0.5);
    // ⚠ 13:39:57 第 4 次写盘：默认 mode 字面量 'r81' 改为模块级常量
    //   R81_ROOF_CULL_DEFAULT_MODE（R7 3 参调用独立 A/B 逃生门 #r81r7roofcull=off）；
    //   node/SSR 无 window ⇒ 恒 'r81'，护栏可复现。按落盘实现钉死，不放宽。
    expect(roof).toContain('const R81_ROOF_CULL_DEFAULT_MODE: RoofCullMode =');
    expect(roof).toContain('mode: RoofCullMode = R81_ROOF_CULL_DEFAULT_MODE');
    expect(roof).toContain('r81r7roofcull=off');
    expect(roof).toContain("? 'r80'");
    expect(roof).toContain(": 'r81';");
    // 有 normal 最终判据：region(maxY) && upward(ny>阈值) && horizontal(|ny|>=阈值)
    expect(roof).toContain('const region = Math.max(y0, y1, y2) > roofLocal;');
    expect(roof).toContain('const upward = ny > ROOF_CULL_HORIZONTAL_NY;');
    expect(roof).toContain('hit = region && upward && horizontal;');
    expect(roof).toContain('horizontal = Math.abs(ny) >= ROOF_CULL_HORIZONTAL_NY;');
    // 无 normal 保守退化：只按 minY（allAbove），不抛错、不返回 null
    expect(roof).toContain('const allAbove = Math.min(y0, y1, y2) > roofLocal;');
    expect(roof).toContain('else if (!useNormal) {');
    expect(roof).toContain('hit = allAbove && horizontal;');
    // R80 旧判据只在 mode 分支内保留（A/B 回滚），不得成为默认态
    expect(roof).toContain("if (mode === 'r80') {");
    expect(roof).toContain('hit = Math.max(y0, y1, y2) > roofLocal;');
    // full 恒为逐位拷贝；无 normal 优雅退化
    expect(roof).toContain('const full = new Uint32Array(src);');
    expect(roof).toContain('const useNormal = mode === \'r81\' && !!nrm && nrm.itemSize >= 3;');
    expect(roof).toContain('不抛错、不返回 null');
  });
});

/* ═══════ 4. R81 · 机盖基线守卫（撤销 R80 的 −1.30 默认） ═══════ */

describe('R81 · 4. 机盖机位：默认 −1.45 / 显式开关 −1.30 / #hoodcam 扫参', () => {
  it('【强·运行时】node 默认态 hood 机位 z = −1.45（R65-G8 用户真机基线）', () => {
    const camera = new CameraRig(16 / 9);
    const anchor = new THREE.Vector3(0, 0, 0);
    const quat = new THREE.Quaternion();
    const dt = 1 / 60;
    camera.setMode('cabin');
    for (let i = 0; i < 60; i += 1) camera.update(dt, anchor, 0, quat);
    camera.setMode('hood');
    camera.update(dt, anchor, 0, quat); // 涉内→涉内跨界一帧落位（r31 同款）
    expect(camera.camera.position.x).toBeCloseTo(0, 6);
    expect(camera.camera.position.y).toBeCloseTo(1.45, 6);
    expect(camera.camera.position.z).toBeCloseTo(-1.45, 6);
  });

  it('【弱】HOOD_Z 三元保留 −1.30/−1.45 双值，R80_HOOD_BACK 默认 false', () => {
    expect(rig).toMatch(/HOOD_Y = HOOD_POSE_OVERRIDE\?\.y \?\? 1\.45/);
    expect(rig).toMatch(/HOOD_Z = HOOD_POSE_OVERRIDE\?\.z \?\? \(R80_HOOD_BACK \? -1\.30 : -1\.45\)/);
    expect(rig).toContain('const R80_HOOD_BACK: boolean =');
    // R80 是「默认 true（−1.30）/ off 回 −1.45」；R81 反转为「默认 false / on 才 −1.30」
    expect(rig).toContain("typeof window !== 'undefined' &&");
    expect(rig).toContain("r81hood=on");
    expect(rig).toContain("r80hood=off");
    const decl = slice(rig, 'const R80_HOOD_BACK: boolean =', 'const HOOD_Y');
    expect(decl).toContain('r81hood=on');
    expect(decl).toContain('r80hood=off');
    expect(decl).not.toContain("typeof window === 'undefined' ||"); // R80 旧默认 true 已撤销
    expect(rig).toContain('POSE.offset.set(0, HOOD_Y, HOOD_Z);');
  });

  it('【弱】#hoodcam 扫参正则与 #hoodcam=off 回滚机位未被破坏', () => {
    expect(rig).toContain('hoodcam=off');
    expect(rig).toContain('return { y: 1.55, z: 1.4, lookY: 0.9 };');
    // 逐字钉扫参正则本体（含三参可选组），避免正则套正则的转义歧义
    expect(rig).toContain('/[#&]hoodcam=(-?[\\d.]+),(-?[\\d.]+)(?:,(-?[\\d.]+))?/.exec(window.location.hash)');
    expect(rig).toContain('POSE.look.set(0, HOOD_LOOK_Y, -16);');
  });
});

/* ═══════ 5. P1-5 · 方向盘门控有限性守卫 ═══════ */

describe('R81 · 5. P1-5 V800Adapter clearance 有限性 + 滞回 0.16/0.26 未改', () => {
  it('【弱】滞回常量与门控开关 / 回滚钩子逐字保留', () => {
    expect(adapter).toContain('const STEER_GATE_NEAR_M = 0.16;');
    expect(adapter).toContain('const STEER_GATE_FAR_M = 0.26;');
    expect(adapter).toContain('r71steergate=off');
    expect(adapter).toContain('const R81_STEER_GATE_GUARD: boolean =');
    expect(adapter).toContain('r81steergate=off');
    expect(adapter).toContain('const STEER_GATE_RADIUS_MIN_M = 0.05;');
    expect(adapter).toContain('const STEER_GATE_RADIUS_MAX_M = 0.50;');
    // 滞回三态语义逐位不变（只是判据变量由 clearance 换成受保护的 c）
    expect(adapter).toContain('const next = steerNearCam ? c < STEER_GATE_FAR_M : c < STEER_GATE_NEAR_M;');
    expect(adapter).toContain('steerNearCam = next;');
  });

  it('【弱】装载期半径：Number.isFinite + 正性校验 + 0.225 兜底 + [0.05,0.50] clamp', () => {
    const load = slice(adapter, 'wheel.geometry.computeBoundingSphere();', 'wheel.visible = false;');
    expect(load.length, '方向盘装载切片失败').toBeGreaterThan(100);
    expect(load).toContain('const bsRadius = wheel.geometry.boundingSphere?.radius;');
    expect(load).toContain('(bsRadius ?? 0.225) * Math.abs(wheel.scale.x)');
    expect(load).toContain('Number.isFinite(scaledRadius) && scaledRadius > 0');
    expect(load).toContain(': 0.225;');
    expect(load).toContain('steerGateRadius = R81_STEER_GATE_GUARD');
    expect(load).toContain('Math.min(STEER_GATE_RADIUS_MAX_M, Math.max(STEER_GATE_RADIUS_MIN_M, finiteRadius))');
    expect(load).toContain(': scaledRadius;'); // off 逐位回 R80 原式
  });

  it('【弱】applySteerGate：dist/clearance 双有限性保护 + clamp≥0 + 非有限保持态', () => {
    const fn = slice(adapter, 'const applySteerGate = (dist: number): void => {', 'const api = {');
    expect(fn.length, 'applySteerGate 函数体切片失败').toBeGreaterThan(100);
    expect(fn).toContain('const clearance = dist - steerGateRadius;');
    expect(fn).toContain('const c = R81_STEER_GATE_GUARD');
    expect(fn).toContain('Number.isFinite(dist) && Number.isFinite(clearance)');
    expect(fn).toContain('Math.max(0, clearance)');
    expect(fn).toContain(': clearance;'); // off 逐位回 R80
    expect(fn).toContain('if (c === null) return;'); // NaN ⇒ 门控不许翻转
    expect(fn).toContain('if (next === steerNearCam) return;'); // 带内不抖
  });
});
