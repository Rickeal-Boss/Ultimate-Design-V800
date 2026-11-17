/**
 * R92 · 尾灯 LUXEED 字标镜像根治护栏（审查报告 §3，连续三波未修的头号 P0）
 *
 * 定罪链（审查线已独立复跑，本护栏只防回退、不重复定罪）：
 *  · 唯一带 map 的尾标 quad = `r89_r7_tail_mask`（ExternalShell.ts，法线 (0,0,-1)、
 *    从车尾外看是背面）⇒ atlas u 方向反，中段 LUXEED 读作镜像 `DEEXUL`。
 *  · R91 实测：只把 u 翻转（u0/u1 对调）⇒ 字标区 8.05% 像素变化、放大正读 LUXEED。
 *
 * 本护栏钉五条不变量（源码结构 + 纯函数数值 + UV 数值证明，非渲染画面）：
 *  1. maskGeo 的 u0/u1 对调（默认态 u0>u1），v 区间仍 0.40/0.68；
 *  2. `#r92badgeu=off` 回滚态 u0<u1（镜像态），开关走 r51HookOff('r92badgeu')、
 *     键名不含 noprewarm、不碰 R86 的 `#r86r7tailu`；
 *  3. quad 几何契约未破：法线恒 (0,0,-1)、4 顶点、索引 2-tri（索引 [0,1,2,1,3,2]）；
 *  4. 导出纯函数 `r92BadgeURange(on)` 两态 u 区间与源码 remap 三元逐字一致；
 *  5. 数值证明：把源 quad UV 经 remapUVToRegion(on 区间) 后，左世界顶点采样 atlas 右端、
 *     右世界顶点采样 atlas 左端（u 确实水平翻转），v 落在 [0.40,0.68]。
 *
 * ⚠ 铁律（沿用 r68_visual / r59 护栏）：readFileSync 前一律 `git ls-files` 验入库，
 *   只读已 tracked 的 ExternalShell.ts；不读 .qa / dist / 未入库工具 / 本机绝对路径。
 *   vitest 无 window ⇒ `R92_BADGE_U_ON` 恒 true（默认翻转态），off 态用导出纯函数
 *   `r92BadgeURange(false)` + 源码三元分支断言，不做同页改 hash 的动态 import。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  R92_BADGE_U_ON,
  r92BadgeURange
} from '../src/model/external/ExternalShell';
import { remapUVToRegion } from '../src/model/parts/tailLampC2';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** git tracked 校验：未入库 ⇒ 抛错（CI 干净 checkout 的 ENOENT 防线）。 */
function lsFiles(p: string): string {
  try {
    return execFileSync('git', ['ls-files', '--', p], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).replace(/\r\n/g, '\n').trim();
  } catch {
    throw new Error(`[R92] git ls-files 不可用，无法验证入库状态：${p}`);
  }
}

/** readFileSync 前必验入库。 */
const src = (p: string): string => {
  if (lsFiles(p) !== p) throw new Error(`[R92] 文件未入 git，CI 干净 checkout 会 ENOENT：${p}`);
  return readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
};

const shell = src('src/model/external/ExternalShell.ts');
const slice = (s: string, from: string, to: string): string => {
  const a = s.indexOf(from);
  const b = a < 0 ? -1 : s.indexOf(to, a);
  return a < 0 || b < 0 ? '' : s.slice(a, b);
};

/** maskGeo 装配段（从构造到 atlas 选择前），限定断言作用域。 */
const maskBlock = slice(
  shell,
  'const maskGeo = new THREE.BufferGeometry();',
  'const maskAtlas ='
);

/** 解析 remap 调用：捕获 on/off 两态的 u0/u1 与 v0/v1 字面量。 */
const REMAP_RE = /remapUVToRegion\(maskGeo,\s*R92_BADGE_U_ON \? ([\d.]+) : ([\d.]+),\s*R92_BADGE_U_ON \? ([\d.]+) : ([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/;
const reMap = REMAP_RE.exec(maskBlock);
const parsed = reMap
  ? { onU0: +reMap[1], offU0: +reMap[2], onU1: +reMap[3], offU1: +reMap[4], v0: +reMap[5], v1: +reMap[6] }
  : null;

describe('R92 · 0. 只读 git tracked 铁律', () => {
  it('ExternalShell.ts 已入库（git ls-files），护栏只读 tracked 源码', () => {
    expect(lsFiles('src/model/external/ExternalShell.ts')).toBe('src/model/external/ExternalShell.ts');
    expect(maskBlock.length).toBeGreaterThan(100);
    expect(parsed).not.toBeNull();
  });
});

describe('R92 · 1. 默认态 u0>u1（翻 u 正读），off 态 u0<u1（镜像回滚）', () => {
  it('★ remap 三元逐字：默认 u0=0.664>u1=0.336，off u0=0.336<u1=0.664', () => {
    expect(parsed).toEqual({
      onU0: 0.664, offU0: 0.336,
      onU1: 0.336, offU1: 0.664,
      v0: 0.40, v1: 0.68
    });
    // 默认（on）分支：u0 > u1 ⇒ 反向区间 ⇒ 水平翻转
    expect(parsed!.onU0).toBeGreaterThan(parsed!.onU1);
    // off 回滚分支：u0 < u1 ⇒ 正向区间 ⇒ 回到镜像态
    expect(parsed!.offU0).toBeLessThan(parsed!.offU1);
    // 两态互为 u 对调：onU0 === offU1 且 onU1 === offU0
    expect(parsed!.onU0).toBe(parsed!.offU1);
    expect(parsed!.onU1).toBe(parsed!.offU0);
  });

  it('★ v 区间仍 0.40/0.68（未跟随 u 翻转），且未退化成整幅 0..1', () => {
    expect(parsed!.v0).toBe(0.40);
    expect(parsed!.v1).toBe(0.68);
    expect(maskBlock).toMatch(/0\.40,\s*0\.68\)/);
    expect(maskBlock).not.toMatch(/remapUVToRegion\(maskGeo,\s*0,\s*1,\s*0,\s*1\)/);
  });

  it('★ 开关走 r51HookOff(\'r92badgeu\')，默认 ON，键名不含 noprewarm，不碰 R86', () => {
    expect(shell).toContain("export const R92_BADGE_U_ON = !r51HookOff('r92badgeu');");
    expect(shell).toContain('#r92badgeu=off');
    expect('r92badgeu').not.toContain('noprewarm');
    // R86 是 band 字标，非本 badge mask：remap 调用行不得改用 R86 开关驱动
    const remapLine = maskBlock.split('\n').find((l) => l.includes('remapUVToRegion(maskGeo')) ?? '';
    expect(remapLine).not.toContain('r86r7tailu');
    expect(remapLine).not.toContain('R86_R7_TAIL_U_ON');
    expect(remapLine).toContain('R92_BADGE_U_ON');
    // Node / vitest 无 window ⇒ 默认翻转态
    expect(R92_BADGE_U_ON).toBe(true);
  });
});

describe('R92 · 2. 导出纯函数两态区间与源码三元逐字一致', () => {
  it('★ r92BadgeURange(true/false) 返回 [u0,u1]，默认 u0>u1、off u0<u1', () => {
    const on = r92BadgeURange(true);
    const off = r92BadgeURange(false);
    expect(on).toEqual([0.664, 0.336]);
    expect(off).toEqual([0.336, 0.664]);
    expect(on[0]).toBeGreaterThan(on[1]);
    expect(off[0]).toBeLessThan(off[1]);
    // 与源码解析值逐位一致（防止纯函数与装配处三元漂移）
    expect([...on]).toEqual([parsed!.onU0, parsed!.onU1]);
    expect([...off]).toEqual([parsed!.offU0, parsed!.offU1]);
    // 纯函数体内只含两组 u 区间字面量，不写 v（v 由装配处固定 0.40/0.68）
    const fn = slice(shell, 'export function r92BadgeURange(', '\n}');
    expect(fn).toContain('return on ? [0.664, 0.336] : [0.336, 0.664];');
    expect(fn).not.toContain('0.40');
    expect(fn).not.toContain('0.68');
  });

  it('★ hash 回滚语义：#r92badgeu=off 命中 r51HookOff 的 RegExp（参考 r68 hash 读法）', () => {
    // 与 r51HookOff 同构：`=off` 逐位回滚、无 hash / =on 取默认
    const hookOff = (hash: string, key: string): boolean =>
      new RegExp(`(?:^|[#&])${key}=off`, 'i').test(hash);
    expect(hookOff('#r92badgeu=off', 'r92badgeu')).toBe(true);
    expect(hookOff('#r92badgeu=on', 'r92badgeu')).toBe(false);
    expect(hookOff('#other=off', 'r92badgeu')).toBe(false);
    expect(hookOff('#r86r7tailu=off', 'r92badgeu')).toBe(false); // 不误伤 R86 band 开关
    // off 命中 ⇒ 纯函数应取 off 分支（u0<u1 镜像回滚）
    const off = r92BadgeURange(!hookOff('#r92badgeu=off', 'r92badgeu'));
    expect(off[0]).toBeLessThan(off[1]);
  });
});

describe('R92 · 3. quad 几何契约未破（法线 -Z / 4 顶点 / 2-tri）', () => {
  it('★ position 4 顶点、normal 恒 (0,0,-1)、索引 [0,1,2,1,3,2] 恰 2 tri', () => {
    expect(maskBlock).toContain(
      "-maskW / 2, maskY1, maskZ,\n            maskW / 2, maskY1, maskZ,\n            -maskW / 2, maskY0, maskZ,\n            maskW / 2, maskY0, maskZ"
    );
    expect(maskBlock).toContain('0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1');
    expect(maskBlock).toContain('maskGeo.setIndex([0, 1, 2, 1, 3, 2]);');
    expect(maskBlock).toContain('new THREE.Float32BufferAttribute([\n            0, 1, 1, 1, 0, 0, 1, 0\n          ], 2)');
  });

  it('数值重建 quad：法线分量全为 -Z，索引 6 项 = 2 tri', () => {
    const g = new THREE.BufferGeometry();
    // 与源码逐位同参（maskW 取任意值，法线/拓扑与宽度无关）
    const maskW = 0.834, maskY0 = 0.98, maskY1 = 1.08, maskZ = -2.54609;
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -maskW / 2, maskY1, maskZ,
      maskW / 2, maskY1, maskZ,
      -maskW / 2, maskY0, maskZ,
      maskW / 2, maskY0, maskZ
    ], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([
      0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1
    ], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([
      0, 1, 1, 1, 0, 0, 1, 0
    ], 2));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < 4; i += 1) {
      expect(n.getX(i)).toBe(0);
      expect(n.getY(i)).toBe(0);
      expect(n.getZ(i)).toBe(-1);
    }
    expect(g.getAttribute('position').count).toBe(4);
    expect((g.index?.count ?? 0) / 3).toBe(2);
  });
});

describe('R92 · 4. 数值证明：on 区间让 u 水平翻转、v 不变', () => {
  const mkQuad = (): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('uv', new THREE.Float32BufferAttribute([
      0, 1, 1, 1, 0, 0, 1, 0
    ], 2));
    return g;
  };

  it('★ 默认区间 remap 后：左顶点采样 atlas 右端、右顶点采样左端（u 反）', () => {
    const g = mkQuad();
    remapUVToRegion(g, parsed!.onU0, parsed!.onU1, parsed!.v0, parsed!.v1);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    // 左世界顶点 (原 u=0) → atlas u=0.664；右世界顶点 (原 u=1) → atlas u=0.336
    expect(uv.getX(0)).toBeCloseTo(0.664, 6);
    expect(uv.getX(1)).toBeCloseTo(0.336, 6);
    expect(uv.getX(2)).toBeCloseTo(0.664, 6);
    expect(uv.getX(3)).toBeCloseTo(0.336, 6);
    expect(uv.getX(0)).toBeGreaterThan(uv.getX(1)); // 水平翻转的确证
    // v 落在 [0.40,0.68]：顶 v=1→0.68，底 v=0→0.40
    expect(uv.getY(0)).toBeCloseTo(0.68, 6);
    expect(uv.getY(2)).toBeCloseTo(0.40, 6);
  });

  it('★ off 区间 remap 后：u 不翻转（左→左、右→右 = 镜像回滚态）', () => {
    const g = mkQuad();
    remapUVToRegion(g, parsed!.offU0, parsed!.offU1, parsed!.v0, parsed!.v1);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    expect(uv.getX(0)).toBeCloseTo(0.336, 6);
    expect(uv.getX(1)).toBeCloseTo(0.664, 6);
    expect(uv.getX(2)).toBeCloseTo(0.336, 6);
    expect(uv.getX(3)).toBeCloseTo(0.664, 6);
    expect(uv.getX(0)).toBeLessThan(uv.getX(1)); // 未翻转 = 镜像态
    // v 区间两态一致
    expect(uv.getY(0)).toBeCloseTo(0.68, 6);
    expect(uv.getY(2)).toBeCloseTo(0.40, 6);
  });

  it('★ on/off 两态像素采样区间互补：同一世界顶点 u_on + u_off === 1.0（0.336+0.664）', () => {
    const on = mkQuad();
    const off = mkQuad();
    remapUVToRegion(on, parsed!.onU0, parsed!.onU1, parsed!.v0, parsed!.v1);
    remapUVToRegion(off, parsed!.offU0, parsed!.offU1, parsed!.v0, parsed!.v1);
    const a = on.getAttribute('uv') as THREE.BufferAttribute;
    const b = off.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < 4; i += 1) {
      expect(a.getX(i) + b.getX(i)).toBeCloseTo(1.0, 6);
      expect(a.getY(i)).toBeCloseTo(b.getY(i), 6); // v 两态逐位相同
    }
  });
});
