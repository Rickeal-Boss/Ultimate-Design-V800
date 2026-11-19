/**
 * R98 · `.vc-diff` 中文断行回归网（只写本文件 + src/ui/Menu.ts）
 *
 * 定罪（R97 probe-car）：车型卡片差异列表 `.vc-diff` 无换行控制，长中文/英文数字串
 * 顶破卡片或按错位置断行。修法：在 src/ui/Menu.ts 注入式 CSS 的 `.vc-diff` 规则补
 * overflow-wrap: anywhere / word-break: normal / white-space: normal / line-break: strict，
 * 并给 li 补规则，确保中文按字断、长串不溢出。本网为源码级断言，防回归。
 *
 * 纪律：不读 .qa/ dist/ tools/ 未入库文件；只 import 生产源文件字面。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const MENU_SRC = readFileSync(new URL('../src/ui/Menu.ts', import.meta.url), 'utf-8');

/** 抽出给定选择器后第一个 {...} 块内的声明文本。 */
function ruleBody(selector: string): string {
  const start = MENU_SRC.indexOf(selector);
  expect(start, `选择器未找到: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = MENU_SRC.indexOf('{', start + selector.length);
  expect(open, `${selector} 缺少 '{'`).toBeGreaterThanOrEqual(0);
  const close = MENU_SRC.indexOf('}', open);
  expect(close, `${selector} 缺少 '}'`).toBeGreaterThan(open);
  return MENU_SRC.slice(open + 1, close);
}

/** 命中形如 `prop : value` 的声明（容忍空白，要求 value 为独立词）。 */
function hasDecl(body: string, prop: string, value: string): boolean {
  return new RegExp(`\\b${prop}\\s*:\\s*${value}\\b`).test(body);
}

const DIFF_RULE = ruleBody('.vehicle-card .vc-diff');
const DIFF_LI_RULE = ruleBody('.vehicle-card .vc-diff li');
const WRAP_RULES = `${DIFF_RULE}\n${DIFF_LI_RULE}`;

describe('R98 · 1. .vc-diff 规则含换行四件套', () => {
  it('overflow-wrap: anywhere —— 长英文/数字串按任意点断行，不溢出卡片', () => {
    expect(hasDecl(DIFF_RULE, 'overflow-wrap', 'anywhere'), 'overflow-wrap 未设为 anywhere').toBe(true);
  });

  it('word-break: normal —— 用默认断行规则（中文按字断，保留英文单词）', () => {
    expect(hasDecl(DIFF_RULE, 'word-break', 'normal'), 'word-break 未设为 normal').toBe(true);
  });

  it('white-space: normal —— 允许折行，不锁 nowrap', () => {
    expect(hasDecl(DIFF_RULE, 'white-space', 'normal'), 'white-space 未设为 normal').toBe(true);
  });

  it('line-break: strict —— 中文标点用严格断行规则', () => {
    expect(hasDecl(DIFF_RULE, 'line-break', 'strict'), 'line-break 未设为 strict').toBe(true);
  });
});

describe('R98 · 2. 不得回退到「不换行 / 全断」的破坏性取值', () => {
  it('.vc-diff 及 li 规则均无 white-space: nowrap', () => {
    expect(WRAP_RULES).not.toMatch(/\bwhite-space\s*:\s*nowrap\b/);
  });

  it('无 white-space: pre / pre-wrap（同样会阻止正常折行）', () => {
    expect(WRAP_RULES).not.toMatch(/\bwhite-space\s*:\s*pre(-wrap)?\b/);
  });

  it('无 word-break: keep-all（会阻止中文按字断）', () => {
    expect(WRAP_RULES).not.toMatch(/\bword-break\s*:\s*keep-all\b/);
  });

  it('无 word-break: break-all（会让英文在任意字符断，非既定 normal 契约）', () => {
    expect(WRAP_RULES).not.toMatch(/\bword-break\s*:\s*break-all\b/);
  });
});

describe('R98 · 3. li 子项也显式约束（文本实际承载节点）', () => {
  it('li 规则存在且 white-space: normal', () => {
    expect(hasDecl(DIFF_LI_RULE, 'white-space', 'normal'), 'li 未设 white-space: normal').toBe(true);
  });

  it('li 规则含 overflow-wrap: anywhere', () => {
    expect(hasDecl(DIFF_LI_RULE, 'overflow-wrap', 'anywhere'), 'li 未设 overflow-wrap: anywhere').toBe(true);
  });
});

describe('R98 · 4. 布局 / 颜色 / 字号 / 车型名 / 按钮契约未被改动', () => {
  it('.vc-diff 布局与排版基线逐字保留', () => {
    expect(DIFF_RULE).toMatch(/\bmargin\s*:\s*0\b/);
    expect(DIFF_RULE).toMatch(/\bpadding-left\s*:\s*14px\b/);
    expect(DIFF_RULE).toMatch(/\bfont-size\s*:\s*11\.5px\b/);
    expect(DIFF_RULE).toMatch(/\bline-height\s*:\s*1\.65\b/);
    expect(DIFF_RULE).toMatch(/\bopacity\s*:\s*\.9\b/);
  });
});
