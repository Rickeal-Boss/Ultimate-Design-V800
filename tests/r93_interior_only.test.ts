/**
 * R93 · yangwang 复用 V800 座舱「绝不下载 v800 外部壳」护栏
 *
 * 定罪（主理人线上 3/3 复现）：
 *  · `#vehicle=yangwang` 时加载屏 100s+ 永不消失，网络日志显示**同时下载两套资产**：
 *    yangwang 自身 GLB（28.7MB）+ v800 全套外部壳（28MB，body/wheels/glass/lamps）。
 *  · 根因：`YangwangAdapter.ts` 复用 `createV800CarAdapter(tier)` 时，`V800Adapter.ts`
 *    的外壳 IIFE（`loadExternalShell('v800', ...)`）**无条件执行**——即使本实例只被当
 *    内饰用，也下载整套 v800 外壳并挂进 body，拖死加载门。
 *
 * 本护栏钉三条不变量（纯源码结构，不渲染、不 import 重型 V800Adapter）：
 *  1. `createV800CarAdapter` 签名含可选 `opts?: { interiorOnly?: boolean }`；
 *  2. 外壳 IIFE 顶部有 `if (opts?.interiorOnly) return;`（早退先于 loadExternalShell）；
 *  3. `YangwangAdapter` 复用调用传 `{ interiorOnly: true }`。
 *
 * ⚠ 铁律（沿用 r68_visual / r92_badge 护栏）：readFileSync 前一律 `git ls-files` 验入库，
 *   只读已 tracked 的 src；不读 .qa / dist / 未入库工具 / 本机绝对路径。
 *   因 V800Adapter 改动必须重算冻结 sha（r68_visual.test.ts:170 ADAPTER_SHA256），本文件
 *   同时以源码字符串断言「interiorOnly 守卫存在」，与 r68 的 sha 护栏互补。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** git tracked 校验：未入库 ⇒ 抛错（CI 干净 checkout 的 ENOENT 防线）。 */
function lsFiles(p: string): string {
  try {
    return execFileSync('git', ['ls-files', '--', p], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
  } catch {
    return '';
  }
}

/** 只读已入库源码（LF 归一，与 r68 sha 口径一致）。 */
function srcOf(rel: string): string {
  const tracked = lsFiles(rel);
  expect(tracked, `git ls-files 应含 ${rel}（CI 干净 checkout 无此文件 ⇒ 护栏失效）`).toBe(rel);
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

const V800 = srcOf('src/model/V800Adapter.ts');
const YW = srcOf('src/model/YangwangAdapter.ts');

describe('R93 interiorOnly 护栏（yangwang 复用 V800 座舱不下载 v800 外壳）', () => {
  it('签名含可选 opts.interiorOnly', () => {
    const m = V800.match(/export function createV800CarAdapter\([^)]*\): CarLike \{/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("opts?: { interiorOnly?: boolean }");
  });

  it('外壳 IIFE 顶部有 interiorOnly 早退（先于 loadExternalShell）', () => {
    const iife = V800.indexOf("void (async () => {");
    expect(iife).toBeGreaterThan(-1);
    const head = V800.slice(iife, iife + 900);
    // 早退守卫必须在 loadExternalShell 之前出现
    const guard = head.indexOf("if (opts?.interiorOnly) return;");
    const load = head.indexOf("loadExternalShell('v800'");
    expect(guard).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(guard);
  });

  it('yangwang 复用调用传 { interiorOnly: true }', () => {
    // 精确匹配真实调用（避开第 5 行注释里的 createV800CarAdapter(tier).body）
    const call = YW.match(/createV800CarAdapter\(tier, undefined, \{ interiorOnly: true \}\)/);
    expect(call, 'yangwang 应显式传第三参 { interiorOnly: true }').not.toBeNull();
    // 第二参 paintId 走默认（undefined 触发 DEFAULT_VARIANT），不误传 v800 车漆
    expect(YW).toMatch(/createV800CarAdapter\(tier, undefined, \{ interiorOnly: true \}\)/);
  });

  it('默认（不传 opts）路径保持可用：Game.ts 主路径调用无 opts 亦合法', () => {
    // Game.ts 的 v800 主路径仍 `createV800CarAdapter(this.tier, paintId ?? undefined)`
    // —— 第三参缺省 ⇒ interiorOnly 未定义 ⇒ 旧行为逐位不变。
    const game = srcOf('src/core/Game.ts');
    expect(game).toMatch(/createV800CarAdapter\(this\.tier, paintId \?\? undefined\)/);
  });

  it('守卫注释说明语义（防后人误删）', () => {
    expect(V800).toContain('interiorOnly（yangwang 复用 V800 座舱）');
    expect(YW).toContain('interiorOnly=true');
  });
});
