/**
 * R60 · P0-1 车身程序化车漆护栏（根治喷溅噪点）
 *
 * 背景（R56 诊断 + R59 外部审查连续 5 轮）：车身 basecolor/normal 是 AI 生成贴图，
 * 岛内高频抖动经 clearcoat/env 放大 = 满屏 speckle。R56 证明在脏贴图上做任何运行时
 * 补救（去噪 normal / 降 clearcoat/env）游戏内均无净收益 ⇒ 唯一根治路径是换掉脏贴图本体。
 * R60：车身 body 材质在 useProcPaint 路径下弃用 basecolor/normal/mr 三张脏贴图，
 * 改走纯程序化 PBR（R60_PROC_PAINT[variant] 的 color/metalness/roughness）。
 *
 * 本护栏钉五条不变量（源码结构，非建模渲染）：
 *  1. R60 开关 R60_PAINT_PROC 存在，`#r60paint=off` 逐位回滚；
 *  2. 程序化路径不加载 basecolor/normal/mr 三张脏贴图（免下载/免显存/免采样）；
 *  3. 程序化分支置 null 四个贴图槽 + 落 R60_PROC_PAINT 的 color/metalness/roughness；
 *  4. setVariant 程序化路径改 color/metalness/roughness（不换贴图，六变体语义保留）；
 *  5. R51 roughness 注入加 `!useProcPaint` 闸（无 mr.png 时不得把常量 roughness 再映射）。
 *  6. R59 脏贴图路径构造体字面量逐位保留（`#r60paint=off` 回滚基线 + r51_visual 护栏依赖）。
 *
 * ⚠ 与 r51_visual/r59 同纪律：只保证代码结构不被回退；真实观感由 Phase 3 审查线 A/B 逐位比对。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = src('src/model/external/ExternalShell.ts');

const slice = (s: string, from: string, to: string): string =>
  s.slice(s.indexOf(from), s.indexOf(to));

describe('R60 · P0-1 程序化车漆开关与裁决点', () => {
  it('R60_PAINT_PROC 开关存在，#r60paint=off 逐位回滚', () => {
    expect(shell).toContain('export const R60_PAINT_PROC = !r60PaintOff()');
    expect(shell).toMatch(/r60paint=off/);
  });

  it('裁决点 useProcPaint 先于 Promise.all（贴图加载分支要读它，无 TDZ）', () => {
    const decideAt = shell.indexOf('const useProcPaint = R60_PAINT_PROC && !materialOverride()');
    const promiseAllAt = shell.indexOf('await Promise.all([');
    expect(decideAt).toBeGreaterThan(-1);
    expect(promiseAllAt).toBeGreaterThan(decideAt);
  });

  it('程序化路径不加载 basecolor/normal/mr 三张脏贴图', () => {
    // 终点用 Promise.all 的收尾 `]);`（三元分支在数组内、await 行之后）
    const loads = slice(shell, 'const useProcPaint', 'lampAtlasTexPromise\n    ]);');
    expect(loads).toMatch(/useProcPaint\s*\?\s*Promise\.resolve\(null\)\s*:\s*loadTexture\(urls\.basecolor/);
    expect(loads).toMatch(/useProcPaint\s*\?\s*Promise\.resolve\(null\)\s*:\s*loadTexture\(new URL\(`\.\.\/\.\.\/assets\/cars\/\$\{car\}\/normal\.png`/);
    expect(loads).toMatch(/useProcPaint\s*\?\s*Promise\.resolve\(null\)\s*:\s*loadTexture\(new URL\(`\.\.\/\.\.\/assets\/cars\/\$\{car\}\/mr\.png`/);
  });
});

describe('R60 · 程序化分支置空贴图槽 + 落 PBR 参数', () => {
  // 锚点用构造后的 R60 分支本体（注释含 ══ 制表符，indexOf 不便匹配）
  const proc = slice(shell, 'if (useProcPaint) {\n      const procPaint', 'QA 材质 A/B');

  it('置 null 四个贴图槽（map/normalMap/roughnessMap/metalnessMap）', () => {
    expect(proc).toContain('material.map = null');
    expect(proc).toContain('material.normalMap = null');
    expect(proc).toContain('material.roughnessMap = null');
    expect(proc).toContain('material.metalnessMap = null');
  });

  it('落 R60_PROC_PAINT[variant] 的 color/metalness/roughness', () => {
    expect(proc).toContain('material.color.setHex(procPaint.color)');
    expect(proc).toContain('material.metalness = procPaint.metalness');
    expect(proc).toContain('material.roughness = procPaint.roughness');
  });

  it('R60_PROC_PAINT 覆盖六变体（v800 白/黑/金 + r7 白/紫/绿）', () => {
    const table = slice(shell, 'const R60_PROC_PAINT', 'const SHELL_HUD_ID');
    for (const v of ['white', 'black', 'gold', 'purple', 'green']) {
      expect(table).toContain(`${v}:`);
    }
  });
});

describe('R60 · setVariant 程序化路径', () => {
  // slice 起点「async setVariant」在 handle 里唯一（接口声明是 setVariant(variantId...) 无 async），
  // 终点用 handle 内唯一的 setGlassOpaque(opaque（接口的是 setGlassOpaque(opaque: boolean): void;）
  const sv = slice(shell, 'async setVariant', 'setGlassOpaque(opaque: boolean): void {');

  it('程序化路径改 color/metalness/roughness，不换贴图', () => {
    expect(sv).toContain('if (useProcPaint)');
    expect(sv).toContain('material.color.setHex(pp.color)');
    expect(sv).toContain('material.metalness = pp.metalness');
    expect(sv).toContain('material.roughness = pp.roughness');
  });

  it('脏贴图路径 setVariant 仍走 loadTexture 换 map（回滚基线保留）', () => {
    expect(sv).toContain('const tex = await loadTexture(url, true, car)');
    expect(sv).toContain('material.map = tex');
  });
});

describe('R60 · R51 roughness 注入闸（无 mr.png 不得再映射常量 roughness）', () => {
  const rough = slice(shell, 'if (R51_ROUGH_ON) {', 'const bodyMesh = bodyFound;');

  it('注入块内 early 跳过程序化路径（保留 if (R51_ROUGH_ON) 字面量作 slice 锚点）', () => {
    expect(rough).toContain('if (useProcPaint)');
    expect(rough).toContain('material.onBeforeCompile = (shader) => {');
    expect(rough).toContain("'#include <roughnessmap_fragment>'");
    expect(rough).toContain('no per-car branch');
  });
});

describe('R60 · R59 脏贴图路径构造体字面量逐位保留（回滚基线 + r51_visual 护栏依赖）', () => {
  it('构造体仍逐字含 roughnessMap: mrTex / metalnessMap: mrTex / roughness: 1', () => {
    expect(shell).toContain('roughnessMap: mrTex, // G 通道');
    expect(shell).toContain('metalnessMap: mrTex, // B 通道');
    expect(shell).toContain('roughness: 1,');
  });
});
