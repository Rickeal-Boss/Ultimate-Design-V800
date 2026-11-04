/**
 * R44-P1 · 速度帧位移改进回归网（源码契约测试，r37_perf 同模式 —— Game.ts 顶层
 * await + window 依赖无法在 node 直接实例化，故钉「结构不变量」）。
 *
 * 钉住三件事（对应 .qa/r44/BRIEF.md 第三节）：
 *   ① 全路径 alpha 插值覆盖：挑战车身 z / 自由探索 x/z / **自由探索 heading（本轮新增）**
 *      都必须吃 alpha 插值，且 prev* 快照必须发生在物理 step 之前（Gaffer 固定步长口径）；
 *   ② 每帧分配热点已清零：fx 载荷复用（禁对象字面量）、framelog 定长 TypedArray（禁 push）；
 *   ③ 物理契约不触碰：本文件顺带盯住 Game.ts 的 fx 减速口径没被顺手改掉
 *      （brakeIntensity = min(1, pedalForce/breakForceN)，redundant 走 forceRatio）。
 *
 * 数值口径备忘（防后人重踩，勿删）：
 *   · heading 插值必须 wrap 感知（FreeDrive.state.heading 归一 (−π,π]，跨边界差值要按 2π 折回），
 *     且带 |Δh|>0.5rad 吸附守卫（传送/复位/翻滚重置不插值）；
 *   · 断裂取样窗口勿跨断点（b=1.0 踏板 1.77s）—— 本文件不跑物理仿真，仅登记口径。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const gameSrc = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8');

describe('R44-P1 插值覆盖（三链路 alpha 契约）', () => {
  it('挑战路径：车身 z 仍按 lerp(prevDistance, distance, alpha) 插值（防倒退）', () => {
    expect(gameSrc).toContain('lerp(this.prevDistance, vehicle.distance, alpha)');
  });

  it('自由探索：x/z 仍按 lerp(prevFree, s.x/z, alpha) 插值（R40 P0-B 防倒退）', () => {
    expect(gameSrc).toContain('lerp(this.prevFreeX, s.x, alpha)');
    expect(gameSrc).toContain('lerp(this.prevFreeZ, s.z, alpha)');
  });

  it('自由探索 heading：本轮新增 wrap 感知 alpha 插值，禁直读 s.heading', () => {
    // rotation.y 必须由 prevFreeHeading + dh*alpha 合成，不允许再出现直读
    expect(gameSrc).toContain('this.car.root.rotation.y = this.prevFreeHeading + dh * alpha;');
    expect(gameSrc).not.toContain('this.car.root.rotation.y = s.heading;');
    // wrap 折回（跨 ±π 边界）
    expect(gameSrc).toContain('if (dh > Math.PI) dh -= Math.PI * 2;');
    expect(gameSrc).toContain('else if (dh < -Math.PI) dh += Math.PI * 2;');
    // 吸附守卫：位移 >5m 或 |Δh|>0.5rad 时不插值（传送/复位/R 键/翻滚重置）
    expect(gameSrc).toContain('jumpX * jumpX + jumpZ * jumpZ > 25 || Math.abs(dh) > 0.5');
  });

  it('prev* 快照必须在 freeDrive.step 之前（Gaffer 固定步长口径）', () => {
    const tickBody = gameSrc.slice(
      gameSrc.indexOf('private tick(step: number): void'),
      gameSrc.indexOf('private handleEvent(event: GameEvent)')
    );
    expect(tickBody).toContain('this.prevFreeX = this.freeDrive.state.x');
    expect(tickBody).toContain('this.prevFreeHeading = this.freeDrive.state.heading');
    expect(tickBody.indexOf('this.prevFreeHeading = this.freeDrive.state.heading')).toBeLessThan(
      tickBody.indexOf('this.freeDrive.step(step)')
    );
  });
});

describe('R44-P1 每帧分配热点清零（GC 29.3ms/轮 削减）', () => {
  it('fx.update 载荷必须复用 this.fxInput，禁每帧对象字面量', () => {
    expect(gameSrc).toContain('private readonly fxInput: FxFrameInput');
    // 两条调用路径都走复用载荷
    expect(gameSrc).not.toMatch(/fx\.update\(dt,\s*\{/);
    expect(gameSrc.match(/this\.fx\.update\(dt, fx\)/g)?.length).toBe(2);
  });

  it('framelog 必须定长 Float32Array（禁逐帧 push 增长）', () => {
    expect(gameSrc).toContain('rows: Float32Array;');
    expect(gameSrc).toContain('n: number;');
    // 采样块用下标写，不允许 push
    const sampleBlock = gameSrc.slice(
      gameSrc.indexOf('if (this.frameLog) {'),
      gameSrc.indexOf('f.lastT = now;')
    );
    expect(sampleBlock).not.toContain('.push(');
    expect(sampleBlock).toContain('f.rows[i] = now - f.lastT;');
  });

  it('HUD 载荷复用不被回退（R14 成果守住）', () => {
    expect(gameSrc).toContain('private readonly hudInput: HudInput');
    // 只盯调用点（this. 前缀；文档注释里的历史写法不含 this.）
    expect(gameSrc).not.toMatch(/this\.hud\.update\(\s*\{/);
    expect(gameSrc).toContain('this.hud.update(h);');
  });
});

describe('R44-P1 物理契约不触碰（fx 减速口径）', () => {
  it('brakeIntensity 口径：redundant 走 forceRatio，正常走 min(1, pedalForce/breakForceN)', () => {
    // 断裂后冗余制动 = 固定 1/4 力度（判负不写 best 的演出口径）；正常 = 踏板比例
    expect(gameSrc).toContain('REDUNDANCY.forceRatio');
    expect(gameSrc).toContain('Math.min(1, this.sm.pedal.pedalForce / BRAKE.breakForceN)');
  });

  it('速度模糊仍按本帧世界位移给强度（R40 P0-C 长帧补偿保留）', () => {
    expect(gameSrc).toContain('const frameDisp = Math.abs(vehicle.speed) * dt;');
    expect(gameSrc).toContain('Math.min(0.18, (frameDisp / 0.925) * 0.12)');
  });
});

/* ══ R46 Phase 2 · FX-A / 探针契约（只新增断言，不删不改 R44 旧断言）══
 * 与 r37_perf 同模式：Game.ts 顶层 await + window 依赖无法在 node 实例化，
 * 故钉「源码结构不变量」。旧 R40 P0-C 公式字符串必须作为 #r46blur=off 分支保留，
 * 否则本文件第 91-94 行的断言直接破绿（CI 门禁）。 */
describe('R46 Phase 2 · 探针 / FX-A 契约', () => {
  const postfxSrc = readFileSync(new URL('../src/render/Postfx.ts', import.meta.url), 'utf8');
  const fxSrc = readFileSync(new URL('../src/fx/index.ts', import.meta.url), 'utf8');

  it('① framelog 三列定长 TypedArray + 下标写（禁 push）+ dump 导出', () => {
    expect(gameSrc).toContain('carZ: Float32Array;');
    expect(gameSrc).toContain('alpha: Float32Array;');
    expect(gameSrc).toContain('blur: Float32Array;');
    expect(gameSrc).toContain('f.carZ[i] = this.car.root.position.z;');
    expect(gameSrc).toContain('f.alpha[i] = alpha;');
    expect(gameSrc).toContain('f.blur[i] = this.postfx.currentStrength;');
    expect(gameSrc).toContain('carZ: Array.from(f.carZ.subarray(0, n))');
    const sampleBlock = gameSrc.slice(
      gameSrc.indexOf('if (this.frameLog) {'),
      gameSrc.indexOf('f.lastT = now;')
    );
    expect(sampleBlock).not.toContain('.push(');
  });

  it('① 自由侧 renderTail 补传 alpha（R45 默认 0 是错的）', () => {
    expect(gameSrc).toContain('this.renderTail(dt, null, alpha);');
  });

  it('② 自由探索补齐 gap 口径，且保留原纯速度映射作为 off 分支', () => {
    expect(gameSrc).toContain('const frameDispFree = absSpeed * dt;');
    expect(gameSrc).toContain('Math.min(0.18, (frameDispFree / 0.925) * 0.12)');
    expect(gameSrc).toContain('Math.min(1, absSpeed / 72) ** 1.6 * 0.07');
  });

  it('③ FX-A：真实渲染跳距 + #r46blur=off 回滚钩子 + 旧公式字符串留存', () => {
    expect(gameSrc).toContain('const renderDisp = Math.abs(prevZ - this.car.root.position.z);');
    expect(gameSrc).toContain('Math.min(0.18, (renderDisp / 0.925) * 0.12)');
    expect(gameSrc).toContain('r46blur=off');
    // 旧断言所依赖的两行必须逐字仍在（防回退）
    expect(gameSrc).toContain('const frameDisp = Math.abs(vehicle.speed) * dt;');
    expect(gameSrc).toContain('Math.min(0.18, (frameDisp / 0.925) * 0.12)');
  });

  it('③ Postfx：一阶滞后（升 20 / 降 8）+ 只读 currentStrength getter', () => {
    expect(postfxSrc).toContain('get currentStrength(): number');
    expect(postfxSrc).toContain('damp(this.blurCurrent, strength, k, dt)');
    expect(postfxSrc).toContain('strength > this.blurCurrent ? 20 : 8');
    // off 分支必须能直写（严格 R45 基线）
    expect(postfxSrc).toContain('if (!smooth || dt <= 0)');
  });

  it('④ fx 粒子：闭包提到模块级、数组解构改索引访问', () => {
    expect(fxSrc).toContain('function randSigned(): number');
    expect(fxSrc).not.toContain('const r = () => Math.random() * 2 - 1;');
    expect(fxSrc).not.toContain('const [lx, lz] = WHEEL_LOCAL[w];');
  });
});
