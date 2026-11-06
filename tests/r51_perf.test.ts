/**
 * R51 Phase 2-A · 性能线回归网（A 加载期 gate / B FX 空池零递交 / E 零每帧分配）
 *
 * 测试形态与 r44_frame.test.ts / r49_perf.test.ts 一致：Game.ts 有顶层 await + window
 * 依赖，Node 下不能直接实例化 ⇒ 钉「源码结构不变量」；能独立实例化的部分
 * （config/r51Perf 状态机、src/fx 的三个池）补**真实运行时单测**，比纯字符串断言更硬。
 *
 * 三条主理人指定的不变量：
 *   ① 加载期 gate 不早放：8s 软超时不 resolve、只有显式 mark 才放行、
 *      markShellAssembled 挂在 postfx.render() 之后且以 `r44External` 已挂树为硬证据；
 *   ② FX 空池零 DC：count=0 + visible=false（visible 才是真零 DC，count=0 仍会发
 *      一次 renderInstances）、稳态零遍历零上传、emit/clear 状态机正确；
 *   ③ 零每帧分配：SessionInput 载荷复用、索引遍历、PHASE_CODE 模块级常量。
 *
 * ⚠ 物理契约零触碰（摩擦圆 / 限速只钳速不断动力 / 涡扇 spool 一阶滞后）由本文件
 *   的「物理口径不变量」段与既有 physics/audio/redundancy 测试共同钉住。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  SHELL_GATE_TIMEOUT_MS,
  SHELL_NO_SHELL_STATES,
  markShellAssembled,
  markShellUnavailable,
  resetShellGateForTest,
  shellGateState,
  shellGateTimedOut,
  waitForShellGate
} from '../src/config/r51Perf';
import { SkidMarks, Sparks, TireSmoke } from '../src/fx';

const gameSrc = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8');
const fxSrc = readFileSync(new URL('../src/fx/index.ts', import.meta.url), 'utf8');
const gateSrc = readFileSync(new URL('../src/config/r51Perf.ts', import.meta.url), 'utf8');

afterEach(() => {
  vi.useRealTimers();
  resetShellGateForTest();
});

/* ══════════════════ ① 加载期 gate 不早放 ══════════════════ */

describe('R51-A 加载期 gate（R45 事故防回退）', () => {
  it('8s 软超时只记标记，绝不 resolve / 绝不提前 hideLoading', async () => {
    vi.useFakeTimers();
    resetShellGateForTest();
    let resolved = 0;
    waitForShellGate(() => {
      resolved += 1;
    });
    await vi.advanceTimersByTimeAsync(SHELL_GATE_TIMEOUT_MS + 1000);
    expect(SHELL_GATE_TIMEOUT_MS).toBe(8000);
    expect(shellGateTimedOut()).toBe(true);
    expect(shellGateState()).toBe('waiting'); // 仍在等加载屏
    expect(resolved).toBe(0); // ← 核心：超时不放行
    markShellAssembled();
    expect(shellGateState()).toBe('assembled');
    expect(resolved).toBe(1);
  });

  it('超时回调源码里不含 settle / onReady（防后人把软超时改成放行）', () => {
    const timerBody = gateSrc.slice(
      gateSrc.indexOf('setTimeout(() => {'),
      gateSrc.indexOf('}, SHELL_GATE_TIMEOUT_MS)')
    );
    expect(timerBody.length).toBeGreaterThan(0);
    expect(timerBody).toContain('timedOut = true');
    expect(timerBody).not.toContain('settle(');
    expect(timerBody).not.toContain('gateReady');
  });

  it('failed / cancelled 是唯一「无壳」放行终态，且放行幂等只一次', () => {
    expect(SHELL_NO_SHELL_STATES).toEqual(['failed', 'cancelled']);
    resetShellGateForTest();
    let resolved = 0;
    waitForShellGate(() => {
      resolved += 1;
    });
    markShellUnavailable();
    markShellAssembled(); // 二次 mark 不得再放行
    expect(shellGateState()).toBe('no-shell');
    expect(resolved).toBe(1);
  });

  it('已 settle 后注册等待者：立即同步回调（gate 早于 Game 注册也不丢放行）', () => {
    resetShellGateForTest();
    markShellAssembled();
    let resolved = 0;
    waitForShellGate(() => {
      resolved += 1;
    });
    expect(resolved).toBe(1);
  });

  it('Game.ts：显式标记挂在 postfx.render() → pollShellGate() 调用链末端', () => {
    const renderIdx = gameSrc.indexOf('this.postfx.render();');
    const pollIdx = gameSrc.indexOf('this.pollShellGate();');
    expect(renderIdx).toBeGreaterThan(-1);
    expect(pollIdx).toBeGreaterThan(renderIdx); // 首帧已渲染之后才轮询
    // 方法定义在调用点之前（源码物理位置），故不能用 indexOf 比大小，改验调用链结构
    const method = gameSrc.slice(
      gameSrc.indexOf('private pollShellGate()'),
      gameSrc.indexOf('private hasMountedExternalShell()')
    );
    expect(method).toContain('markShellAssembled();');
    expect(method).not.toContain('requestAnimationFrame'); // 放行权不在轮询里
    // 只数「行首即调用」的真实调用点（注释里带反引号的说明文字不计）
    const callSites = gameSrc.match(/^\s*markShellAssembled\(\);/gm)?.length ?? 0;
    expect(callSites).toBe(1);
  });

  it('Game.ts：装配完成判据是 r44External 已挂树，不是 fetch 完成', () => {
    expect(gameSrc).toContain('if (!this.hasMountedExternalShell()) return;');
    expect(gameSrc).toContain('.r44External === true');
    expect(gameSrc).toContain("if (state !== 'ready') return;");
    expect(gameSrc).toContain('if (state === null) return;');
    // hasMountedExternalShell 只读标记，不瘦身、不改 visible
    const fn = gameSrc.slice(
      gameSrc.indexOf('private hasMountedExternalShell()'),
      gameSrc.indexOf('private freezeStaticMatrices()')
    );
    expect(fn).toContain('this.car.root.traverse');
    expect(fn).not.toContain('.visible =');
    expect(fn).not.toContain('removeFromParent');
  });

  it('Game.ts：默认走 gate；#r51loadgate=off 逐位回 R50 单帧 rAF', () => {
    expect(gameSrc).toContain('private readonly shellGateEnabled = isR51LoadGateEnabled();');
    expect(gameSrc).toContain('waitForShellGate(() => {');
    expect(gameSrc).toContain('requestAnimationFrame(() => this.onShellGateReady?.());');
    // off 分支保留原首帧回调字符串
    expect(gameSrc).toContain('requestAnimationFrame(() => onFirstFrame());');
    expect(gateSrc).toContain("readOff('r51loadgate')");
  });

  it('A2 静态冻结：只读 scene 顶层 children，绝不遍历 car.root 子树', () => {
    const fn = gameSrc.slice(
      gameSrc.indexOf('private freezeStaticMatrices()'),
      gameSrc.indexOf('private prewarmShellProgramVariants()')
    );
    expect(fn).toContain('for (const child of this.scene.children)');
    expect(fn).toContain('if (child === this.car.root) continue;');
    expect(fn).toContain('o.matrixWorldAutoUpdate = false;');
    expect(fn).not.toContain('this.scene.traverse');
  });

  it('A3 双 program 预热：零绘制（renderer.compile）+ finally 还原 side', () => {
    const fn = gameSrc.slice(
      gameSrc.indexOf('private prewarmShellProgramVariants()'),
      gameSrc.indexOf('帧尾（挑战模式与自由探索共用）')
    );
    expect(fn).toContain('this.renderer.compile(this.scene, this.rig.camera);');
    expect(fn).toContain('THREE.DoubleSide');
    expect(fn).toContain('bodyMat.side = originalSide;');
    expect(fn).not.toContain('setRenderTarget');
    expect(fn).not.toContain('composer.render');
  });
});

/* ══════════════════ ② FX 空池零 DC ══════════════════ */

describe('R51-B FX 空池零递交（运行时 + 源码契约）', () => {
  it('SkidMarks：初始 count=0 / visible=false，update 空池零遍历，emit→clear 状态机正确', () => {
    const skid = new SkidMarks(8);
    const mesh = skid.object as THREE.InstancedMesh;
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    skid.update(0.016); // 空池快速返回
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    skid.emit(0, 0, 0);
    expect(mesh.count).toBe(1);
    expect(mesh.visible).toBe(true);
    skid.update(0.016);
    expect(mesh.visible).toBe(true);
    skid.clear();
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    skid.dispose();
  });

  it('SkidMarks：count 随 ring cursor 单调增长且不超过池容量（不漏画已写实例）', () => {
    const skid = new SkidMarks(4);
    const mesh = skid.object as THREE.InstancedMesh;
    for (let i = 0; i < 6; i++) skid.emit(i, 0, 0);
    expect(mesh.count).toBe(4); // 回绕后封顶
    skid.dispose();
  });

  it('TireSmoke：空池 visible=false 且 update 不产生任何 attribute 上传', () => {
    const smoke = new TireSmoke(8);
    const pts = smoke.object as THREE.Points;
    const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const v0 = pos.version;
    expect(pts.visible).toBe(false);
    smoke.update(0.016);
    expect(pts.visible).toBe(false);
    expect(pos.version).toBe(v0); // 零上传
    // 发射后下一帧变为可见并产生一次上传
    smoke.emit(new THREE.Vector3(0, 0, 0), 30, 1, 0.1);
    expect(pts.visible).toBe(false); // emit 本身不翻 visible
    smoke.update(0.016);
    expect(pts.visible).toBe(true);
    expect(pos.version).toBeGreaterThan(v0);
    smoke.clear();
    expect(pts.visible).toBe(false);
    smoke.dispose();
  });

  it('Sparks：burst 前零 DC，burst 后可见，clear 复位', () => {
    const sparks = new Sparks(8);
    const pts = sparks.object as THREE.Points;
    expect(pts.visible).toBe(false);
    sparks.update(0.016);
    expect(pts.visible).toBe(false);
    sparks.burst(new THREE.Vector3());
    expect(pts.visible).toBe(false); // burst 只置 active
    sparks.update(0.016);
    expect(pts.visible).toBe(true);
    sparks.clear();
    expect(pts.visible).toBe(false);
    sparks.dispose();
  });

  it('源码契约：visible 才是真零 DC（count=0 仍会发一次 renderInstances），off 钩子保留', () => {
    expect(fxSrc).toContain('this.mesh.count = FX_IDLE_GATE ? 0 : poolSize;');
    expect(fxSrc).toContain('if (FX_IDLE_GATE) this.mesh.visible = false;');
    expect(fxSrc).toContain('if (FX_IDLE_GATE && !this.mesh.visible) return;');
    expect(fxSrc).toContain('if (FX_IDLE_GATE && !this.active)');
    expect(fxSrc).toContain('const FX_IDLE_GATE = isR51FxIdleEnabled();');
    // 发射/淡出公式逐位不动（不削面、不降画质）
    expect(fxSrc).toContain('const rate = 200 * intensity * Math.min(1, speedMs / 30) + 10 * intensity;');
    expect(fxSrc).toContain('p.alphaAttr[i] = 1 - t;');
    expect(fxSrc).toContain('premultipliedAlpha: true');
    expect(fxSrc).toContain('frustumCulled = false');
  });
});

/* ══════════════════ ③ 零每帧分配 ══════════════════ */

describe('R51-E 每帧分配清扫（含物理契约不触碰）', () => {
  it('SessionInput 载荷复用：禁每物理步对象字面量，改索引遍历', () => {
    expect(gameSrc).toContain('private readonly smInput: SessionInput');
    expect(gameSrc).toContain('const events = this.sm.step(step, this.zeroGc ? input : { ...input });');
    expect(gameSrc).toContain('for (let i = 0; i < events.length; i++) this.handleEvent(events[i]);');
    expect(gameSrc).not.toMatch(/this\.sm\.step\(step,\s*\{/);
    expect(gameSrc).not.toMatch(/for \(const event of events\)/);
    expect(gameSrc).toContain("private readonly zeroGc = isR51ZeroGcEnabled();");
  });

  it('PHASE_CODE 提到模块级：#fprobe 帧不再新建 6 键对象字面量', () => {
    expect(gameSrc).toContain('const PHASE_CODE: Readonly<Record<string, number>>');
    expect(gameSrc).toContain('phase: PHASE_CODE[this.sm.phase]');
    expect(gameSrc).not.toMatch(/phase:\s*\{\s*menu:/);
  });

  it('R44 既有零分配成果不被回退（fxInput / hudInput / framelog 定长）', () => {
    expect(gameSrc).not.toMatch(/fx\.update\(dt,\s*\{/);
    expect(gameSrc.match(/this\.fx\.update\(dt, fx\)/g)?.length).toBe(2);
    expect(gameSrc).not.toMatch(/this\.hud\.update\(\s*\{/);
    expect(gameSrc).toContain('rows: Float32Array;');
  });

  it('物理 / 音效契约不触碰：摩擦圆减速口径、冗余力比、限速只钳速不断动力', () => {
    expect(gameSrc).toContain('REDUNDANCY.forceRatio');
    expect(gameSrc).toContain('Math.min(1, this.sm.pedal.pedalForce / BRAKE.breakForceN)');
    // 自动切入只在 #autodrive 且稳态限速时置 forceBrakeTick，不切断动力
    expect(gameSrc).toContain(
      "if (this.autoDrive && this.sm.phase === 'accel' && this.sm.atLimiter) this.forceBrakeTick = true;"
    );
    expect(gameSrc).toContain('const frameDisp = Math.abs(vehicle.speed) * dt;');
    expect(gameSrc).toContain('Math.min(0.18, (frameDisp / 0.925) * 0.12)');
  });

  it('五个回滚钩子齐备且默认开（off 才关）', () => {
    for (const key of [
      'r51loadgate',
      'r51fxidle',
      'r51zerogc',
      'r51matfreeze',
      'r51sidewarm'
    ]) {
      expect(gateSrc).toContain(`readOff('${key}')`);
    }
    // 键名不得含 `noprewarm` 子串（Game.ts:575 入口守卫是 hash.includes）
    expect(gateSrc).toContain("hash.includes('noprewarm')");
    for (const key of ['r51loadgate', 'r51fxidle', 'r51zerogc', 'r51matfreeze', 'r51sidewarm']) {
      expect(key.includes('noprewarm')).toBe(false);
    }
  });
});
