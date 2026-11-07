/**
 * R59 · 外部壳 r44External 标记语义护栏（防 R57/R58 同源 bug 第三次复发）
 *
 * 背景（R58 深度审查报告 §三，主理人接手后确认）：
 *  · setExteriorHidden 用 root.traverse(cb)。three.js 的 Object3D.traverse 是
 *    「回调(this) → 无条件递归所有 children」，回调里的 return **不会阻止遍历子树**。
 *  · R58 原注释声称「不打 r44External，因 traverse 遇外部壳本体提前 return 不触及
 *    bodyMesh 子树」—— 推理错误。rear_badge_v800 之所以没被隐藏，是因为 V800Adapter
 *    对 bodyMesh **整树** traverse 打标，不是因为「不需要」。
 *  · R57 同源 bug：child 挂 lampMesh 下、Adapter 只逐个自身打标 ⇒ 从上线起一直被隐藏
 *    （「功能写了但一个像素都看不见」）。这类 bug 目检抓不到，只有 A/B 逐位比对才抓得到。
 *
 * 本护栏钉三条不变量（源码结构，非建模渲染）：
 *  1. R58 ribbon mesh 显式打 r44External（防御，挂点/装配顺序变化也不退化）；
 *  2. R58 头注不得再保留「不打 r44External / 提前 return 不触及子树」的错误推理；
 *  3. V800Adapter 对 bodyMesh 整树 traverse 打标的路径仍在（正常显隐的真正来源）。
 *
 * ⚠ 与 r51_visual 同纪律：只保证代码结构不被回退；真实显隐由 Phase 3 审查线 A/B 逐位比对。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = src('src/model/external/ExternalShell.ts');
const v800 = src('src/model/V800Adapter.ts');

/** 取某个函数体（限定断言作用域，避免被其它同名片段误伤） */
const slice = (s: string, from: string, to: string): string =>
  s.slice(s.indexOf(from), s.indexOf(to));

describe('R59 · R58 rear_badge_v800 r44External 显式标记', () => {
  const fn = slice(shell, 'function r58BuildRearBadge', '/** R46：当前加载的 AbortController');

  it('ribbon mesh 命名保持 rear_badge_v800（消去法/A-B 探针依赖此名）', () => {
    expect(fn).toContain("mesh.name = 'rear_badge_v800'");
  });

  it('显式打 r44External=true（防御性，不依赖父节点整树 traverse）', () => {
    expect(fn).toContain('r44External = true');
  });

  it('显式标记在 bodyMesh.add(mesh) 之前（挂载前生效，无遗漏窗口）', () => {
    const markAt = fn.indexOf('r44External = true');
    const addAt = fn.indexOf('bodyMesh.add(mesh)');
    expect(markAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(markAt);
  });
});

describe('R59 · R58 头注错误推理已修正', () => {
  // R58 头注作用域：从 R58 段起到剖面常量声明前
  const head = slice(shell, 'R58 · V800 车尾 MAEXTRO', 'const R58_V800_REAR_PROF');

  it('不再声称「不打 r44External」', () => {
    expect(head).not.toMatch(/不打\s*r44External/);
  });

  it('不再声称 traverse「提前 return 不触及子树」（three.js traverse 会递归子树）', () => {
    expect(head).not.toMatch(/提前\s*return[^\n]*不触及/);
  });

  it('保留正确推理：结论侥幸正确源于 Adapter 整树打标（留给后人）', () => {
    expect(head).toMatch(/整树/);
  });
});

describe('R59 · V800Adapter bodyMesh 整树打标路径仍在（正常显隐真正来源）', () => {
  it('shell.bodyMesh.traverse 打 r44External（rear_badge 现能显隐的机制）', () => {
    expect(v800).toMatch(/shell\.bodyMesh\.traverse\(/);
    expect(v800).toMatch(/r44External\s*=\s*true/);
  });

  it('语义部件 glass/lamp 仍逐个自身打标（R57 已给 child 补标记，勿回退）', () => {
    expect(v800).toMatch(/shell\.glassMeshes,\s*\.\.\.shell\.lampMeshes/);
  });
});
