/**
 * R32 C-6 · Waterway 空壳删除后的**残留防线**（第八轮 B3，主理人授权）。
 *
 * 背景：`Waterway` 自 R27 起在类内部整类停用（构造不建几何 / update 不改 uniform /
 * dispose 空转），但调用方接线一直在：`Game.ts` 三处（import / 字段 / 构造）
 * + `update()` 两处 + `dispose()` 一处；`waterTexture.ts` 零消费；根 `water-qa.html`
 * 是 R13 遗留 QA 页。R32 C-6 把这三个文件与全部接线一次性删干净。
 *
 * 本文件锁住三件事，防回升：
 *   ① **文件已删除**（Waterway.ts / waterTexture.ts / water-qa.html）；
 *   ② **`src/` 下零残留 import**（任务硬性要求）：静态 import-from、副作用 import、
 *      动态 `import('…')` 三种写法全查，含 `Waterway` 与 `waterTexture` 两个模块名；
 *   ③ **`Game.ts` 零 `Waterway` 标识符**（接线层）：断言 prev grep 的 6 处命中已归零。
 *
 * 口径说明（为什么只查 import 不查全词匹配）：
 *   `src/render/scene/Road.ts` 的河谷契约注释里仍留着三处「Waterway」字样
 *   （描述 R14 的 Road↔Waterway 开槽契约），Road.ts 不在 C 线白名单，留待 A 线/主理人
 *   处置 —— 注释不算消费点，故这里用 import 语法判定，不放宽也不误伤。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（tests/ 的上一级）；fileURLToPath 保证 Windows 盘符路径正确 */
const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/, '');
const SRC_DIR = join(ROOT, 'src');

/** 递归收集 src/ 下所有 TS 源码（不进 node_modules） */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue;
      walkTs(p, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 三条 import 形态：
 *   a) import { X } from '…/Waterway'      —— 具名/默认/命名空间
 *   b) import '…/Waterway'                 —— 副作用导入
 *   c) await import('…/Waterway')          —— 动态导入
 */
const IMPORT_FROM = /^\s*import\s+[\s\S]*?from\s*['"]([^'"]*(?:Waterway|waterTexture)[^'"]*)['"]/gm;
const IMPORT_BARE = /^\s*import\s*['"]([^'"]*(?:Waterway|waterTexture)[^'"]*)['"]/gm;
const IMPORT_DYNAMIC = /import\s*\(\s*['"]([^'"]*(?:Waterway|waterTexture)[^'"]*)['"]\s*\)/g;

function collectMatches(src: string, re: RegExp): string[] {
  const hits: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) hits.push(m[0].trim().replace(/\s+/g, ' '));
  return hits;
}

describe('R32 C-6 · Waterway 空壳已删（文件存在性）', () => {
  it('三个文件均已不存在', () => {
    expect(existsSync(join(ROOT, 'src/render/scene/Waterway.ts')), 'Waterway.ts 仍在').toBe(false);
    expect(existsSync(join(ROOT, 'src/render/scene/waterTexture.ts')), 'waterTexture.ts 仍在').toBe(false);
    expect(existsSync(join(ROOT, 'water-qa.html')), 'water-qa.html 仍在').toBe(false);
  });
});

describe('R32 C-6 · src/ 下零残留 import（防回升）', () => {
  const files = walkTs(SRC_DIR);

  it('扫到的 src 源码数量 sanity（防止 walk 失效导致断言空转）', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('无任何 Waterway / waterTexture 的 import（静态 / 副作用 / 动态）', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const hit of [
        ...collectMatches(src, IMPORT_FROM),
        ...collectMatches(src, IMPORT_BARE),
        ...collectMatches(src, IMPORT_DYNAMIC)
      ]) {
        offenders.push(`${f.replace(ROOT, '')}: ${hit}`);
      }
    }
    expect(offenders, `残留 import：\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('R32 C-6 · Game.ts 接线已摘净', () => {
  it('Game.ts 零 Waterway 标识符（原 6 处：import/字段/构造/update×2/dispose）', () => {
    const src = readFileSync(join(ROOT, 'src/core/Game.ts'), 'utf8');
    // 去掉注释后判定，避免后人加说明性注释被这里误伤（注释不算消费点）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bWaterway\b/);
    expect(code).not.toMatch(/\bwaterway\b/);
    expect(code).not.toMatch(/waterTexture/);
  });
});
