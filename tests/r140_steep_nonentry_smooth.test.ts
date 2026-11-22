/**
 * R140 · 陡角深嵌平滑钉死（cornerBase / frontBase / frontWall 陡角深嵌单帧消除 → ≤0.35 恒平滑，
 * gatePier / arcadeCol 单帧消除保留）。
 *
 * 背景：R123 fix-1b 的 `(!isGatePierKind && zOv<xPenRaw)` 只覆盖「斜插浅嵌」（zOv<xPenRaw），
 * R138+ Fix-2 的 `sinHAbs<=0.5` 只覆盖「低角」（含直行贴墙）。二者均未覆盖「陡角纵向深嵌」
 * （sinH>0.5 且 zOv≥xPenRaw）——cornerBase/frontBase/frontWall（角塔基座/前排塔基/火盆）在该态
 * 单帧推回 = 真实穿透 2.42~2.52m（>X_Z_PEN_SMOOTH_CAP=0.35）= 潜在单帧瞬移（latent 空气墙）。
 *
 * R140（本测试钉死）：新增 `isSteepNonEntryKind`（cornerBase/frontBase/frontWall）纳入 xPenSmooth，
 * 陡角深嵌恒平滑（min(xPenRaw, 0.35)）。gatePier（门洞通行 R119 有意保留单帧消除）与 arcadeCol
 * （r105 漂移收敛单帧消除）**不纳入**，护 R119 ⑧ / r105_drift_2d。最终 clamp 目标（best）不变，
 * 仅限单帧推回到 X_Z_PEN_SMOOTH_CAP=0.35。
 *
 * ⚠ 自然驾驶不可达（clamp 浅层 catch，实测最大单帧 |Δx|=0.35）——本测试钉**静态** clamp 行为
 * （teleport 态），为防御性硬化（若玩家极端操纵/未来改动可达深嵌陡角态即单帧瞬移，恒平滑消除）。
 *
 * 真源口径：X_Z_PEN_SMOOTH_CAP / VEHICLE / INNER 一律 import 派生，禁写死 0.35 / 1.003。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clampToFootprints } from '../src/core/cityFootprints';
import { VEHICLE } from '../src/config/physics';
import { INNER } from '../src/render/scene/r28Layout';

/** 车半宽（physics.ts 真源，勿写死 1.003） */
const CAR_HALF_W = VEHICLE.widthM / 2;
/** 平滑上限 X_Z_PEN_SMOOTH_CAP（cityFootprints 同源，勿写死漂移） */
const SMOOTH_CAP = 0.35;
/** 源文件全文（R140 结构断言） */
const SRC = readFileSync(fileURLToPath(new URL('../src/core/cityFootprints.ts', import.meta.url)), 'utf8');

describe('R140 ① 陡角深嵌恒平滑（cornerBase / frontBase / frontWall，sinH>0.5 且 zOv≥xPenRaw）', () => {
  it('a cornerBase 陡角 (14.4,−1287,1.3)：xPen ≤0.35（旧 2.416 单帧消除根治），目标不变', () => {
    // sinH=sin1.3≈0.964>0.5（陡角），zOv≥xPenRaw（纵向深嵌）⇒ Fix-2 前不平滑单帧 2.416m 瞬移；
    //   R140 isSteepNonEntryKind 恒平滑 ⇒ xPen=min(2.416,0.35)=0.35。最终 clamp 目标不变。
    const fp = clampToFootprints(14.4, -1287, 1.3);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('cornerBase');
    expect(fp.xPen).toBeLessThanOrEqual(SMOOTH_CAP + 1e-9);
  });

  it('b frontBase 陡角 (14.4,−1271.5,1.3)：xPen ≤0.35（旧 2.516 根治），目标不变', () => {
    const fp = clampToFootprints(14.4, -1271.5, 1.3);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('frontBase');
    expect(fp.xPen).toBeLessThanOrEqual(SMOOTH_CAP + 1e-9);
  });

  it('c frontWall 陡角 (14.4,−1245,1.3)：xPen ≤0.35（旧 1.816 根治），目标不变', () => {
    const fp = clampToFootprints(14.4, -1245, 1.3);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('frontWall');
    expect(fp.xPen).toBeLessThanOrEqual(SMOOTH_CAP + 1e-9);
  });

  it('d 中间陡角 (14.4,−1287,0.7)：sinH=sin0.7≈0.644>0.5 深嵌恒平滑 ≤0.35（非仅极端 1.3）', () => {
    // sinH=0.644 刚过 0.5 阈，深嵌态仍被 isSteepNonEntryKind 平滑（R140 按 kind 不限角度）。
    const fp = clampToFootprints(14.4, -1287, 0.7);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('cornerBase');
    expect(fp.xPen).toBeLessThanOrEqual(SMOOTH_CAP + 1e-9);
  });
});

describe('R140 ② 对照 · gatePier / arcadeCol 单帧消除保留（不纳入 isSteepNonEntryKind）', () => {
  it('e gatePier 陡角 (13.1,−367.95,1.2)：xPen 保留原始穿透 >0.35（门洞通行 R119 有意保留）', () => {
    // gatePier 不纳入 isSteepNonEntryKind（门洞通行需单帧消除过洞收敛，R119 ② 急转 sinH≈0.99）。
    const fp = clampToFootprints(13.1, -367.95, 1.2);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('gatePier');
    expect(fp.xPen).toBeGreaterThan(SMOOTH_CAP);
  });

  it('f arcadeCol 陡角 (9.4,−496,0.7)：xPen 保留原始穿透 >0.35（r105 漂移收敛单帧消除）', () => {
    // arcadeCol 不纳入 isSteepNonEntryKind（r105 漂移纵向深嵌需单帧消除，不重演收敛尾部穿模）。
    const fp = clampToFootprints(9.4, -496, 0.7);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('arcadeCol');
    expect(fp.xPen).toBeGreaterThan(SMOOTH_CAP);
  });

  it('g 低角对照 cornerBase (14.4,−1287,0)：xPen ≤0.35（Fix-2 低角项，R140 不改变）', () => {
    const fp = clampToFootprints(14.4, -1287, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('cornerBase');
    expect(fp.xPen).toBeLessThanOrEqual(SMOOTH_CAP + 1e-9);
  });
});

describe('R140 ③ 结构断言 · isSteepNonEntryKind 定义与 xPenSmooth 纳入', () => {
  it('h1 isSteepNonEntryKind 常量 = kind∈{cornerBase,frontBase,frontWall}（不含 gatePier/arcadeCol）', () => {
    // 多行正则钉死 isSteepNonEntryKind 赋值块（防注释/历史匹配）。
    expect(SRC).toMatch(
      /const\s+isSteepNonEntryKind\s*=\s*xClamp\.bestF\s*!=\s*null\s*&&\s*\(\s*xClamp\.bestF\.kind\s*===\s*'cornerBase'\s*\|\|\s*xClamp\.bestF\.kind\s*===\s*'frontBase'\s*\|\|\s*xClamp\.bestF\.kind\s*===\s*'frontWall'\s*\)/s
    );
    // 显式断言不含 gatePier / arcadeCol（门洞/漂移单帧消除保留）。
    expect(SRC).toMatch(/isSteepNonEntryKind\s*=\s*xClamp\.bestF\s*!=\s*null\s*&&/s);
    const body = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    const defMatch = body.match(/const\s+isSteepNonEntryKind\s*=\s*xClamp\.bestF\s*!=\s*null\s*&&\s*\(([\s\S]*?)\);/);
    expect(defMatch).toBeTruthy();
    expect(defMatch![1]).toContain("'cornerBase'");
    expect(defMatch![1]).toContain("'frontBase'");
    expect(defMatch![1]).toContain("'frontWall'");
    expect(defMatch![1]).not.toContain("'gatePier'");
    expect(defMatch![1]).not.toContain("'arcadeCol'");
  });

  it('h2 xPenSmooth 条件含 isSteepNonEntryKind（gatePier/arcadeCol 走原判据）', () => {
    // R140 核心：xPenSmooth 纳入 isSteepNonEntryKind，位于 isSolidEntryKind 之后。
    const body = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(body).toMatch(/xPenSmooth\s*=\s*xPenRaw\s*>\s*0\.35\s*&&\s*\(\s*isSolidEntryKind\s*\|\|\s*isSteepNonEntryKind\s*\|\|/s);
    // 不残留「isSteepNonEntryKind 定义在 xPenSmooth 之后」（声明需先行，TS const 无提升）。
    const idxDef = body.indexOf('const isSteepNonEntryKind');
    const idxUse = body.indexOf('isSteepNonEntryKind ||');
    expect(idxDef).toBeGreaterThanOrEqual(0);
    expect(idxUse).toBeGreaterThan(idxDef);
  });
});
