/**
 * R49 Phase 2a · 性能落地契约测试（源码字符串断言，与 r48_lamp.test.ts 同风格）。
 *
 * 本波两件改动：
 *  A2 阴影投影代理 —— 外部壳 1.27M/1.39M tri 退出 shadow pass，改由程序化树里
 *     R38-P1-5 瘦身后保留的 castShadow 大件复制「只投影、不显影」的代理承担。
 *  B  默认关动态模糊时跳过整条 SpeedBlur 全屏 pass（blurPass.enabled 动态开关）。
 *
 * 这些是「运行时才装配」的路径（外部壳异步、Postfx 依赖 WebGL），Node 下无法实例化，
 * 故按项目惯例钉**源码结构不变量**；行为口径的正/负判据写在各自注释里。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string =>
  readFileSync(resolve(__dirname, '..', rel), 'utf-8').replace(/\r\n/g, '\n');

/**
 * 去掉注释后的「代码正文」——负向断言必须用它，否则会误伤历史注释。
 * 例：Game.ts:1613 的注释里逐字写着 `renderer.shadowMap.autoUpdate = false`
 * （用于说明 R39 为何删掉那段节流），裸 `toContain` 会把它当成「代码复活」。
 * 同理 `quality.shadowUpdateInterval` 在 :1639 注释里也出现过（「键已删除」）。
 * 注释剥离对 `https://` 之类的字符串有副作用，但本文件只对负向断言取用，
 * 不影响任何正向（`toContain` 仍读原文）。
 */
const codeOnly = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SHELL = 'src/model/external/ExternalShell.ts';
const V800 = 'src/model/V800Adapter.ts';
const R7 = 'src/model/R7Adapter.ts';
const POSTFX = 'src/render/Postfx.ts';
const GAME = 'src/core/Game.ts';

describe('R49-A2 · 阴影投影代理', () => {
  it('外部壳 body + 4 轮 castShadow 由 proxyMode 门控（回滚钩子存在）', () => {
    const s = src(SHELL);
    // R48 是 `bodyMesh.castShadow = true;`；R49 改为受 proxyMode 门控
    expect(s).toContain('const proxyMode = shadowProxyEnabled();');
    expect(s).toContain('bodyMesh.castShadow = !proxyMode;');
    // 四轮同源
    expect(s).toContain('mesh.castShadow = !proxyMode;');
    // 回滚钩子字面量
    expect(s).toContain('r49shadowproxy=off');
  });

  it('代理材质 colorWrite/depthWrite=false（主 pass 零像素、shadow pass 照常写深度）', () => {
    const s = src(SHELL);
    expect(s).toContain('colorWrite: false');
    expect(s).toContain('depthWrite: false');
    // 三个必要闸门：object.visible / material.visible 都必须为真，才能进 shadow pass
    expect(s).toContain('proxy.visible = true;');
    expect(s).toContain('proxy.castShadow = true;');
    // 几何共享（不 clone、不新增显存）
    expect(s).toContain('new THREE.Mesh(src.geometry, matFor(');
    // 与原件同 parent + 局部变换逐位照抄（世界变换恒等）
    expect(s).toContain('parent.add(proxy);');
    expect(s).toContain('const parent = src.parent;');
    expect(s).toContain('proxy.position.copy(src.position);');
    expect(s).toContain('proxy.quaternion.copy(src.quaternion);');
    expect(s).toContain('proxy.scale.copy(src.scale);');
    // 代理必须打 r44External，否则 setExteriorHidden 会把它们连带藏掉
    expect(s).toContain('proxy.userData as { r44External?: boolean }).r44External = true;');
  });

  it('两台适配器都在外部壳装配后建立代理，且受同一门控', () => {
    for (const f of [V800, R7]) {
      const s = src(f);
      expect(s).toContain('buildShadowProxies');
      expect(s).toContain('if (shadowProxyEnabled()) {');
      expect(s).toContain('const proxies = buildShadowProxies(root);');
    }
  });

  it('代理不进 setPaintShadow 的 glass/lamp 显隐循环（须全机位常驻投影）', () => {
    // 该循环只遍历 shell.glassMeshes / shell.lampMeshes，代理不在其中 —— 结构不变即安全。
    // 这里钉住「代理只调一次 build，且不在 setPaintShadow 内」。
    const s = src(V800);
    const paintShadowBody = s.slice(s.indexOf('const setPaintShadow = ('), s.indexOf('/* ══════════════ R38-P1-5'));
    expect(paintShadowBody).not.toContain('buildShadowProxies');
  });
});

describe('R49-B · blurPass 动态开关', () => {
  it('按 uniform 实际值（含 R46 滞后余晖）决定 enabled，判据与 shader early-out 同源', () => {
    const s = src(POSTFX);
    // 必须读 uniform 实际值，不能读 Game 侧目标值
    expect(s).toContain('const s = this.blurPass.uniforms.strength.value as number;');
    expect(s).toContain('const f = this.blurPass.uniforms.flash.value as number;');
    expect(s).toContain('this.blurPass.enabled = s > 0.0001 || f > 0.0001;');
    // setSpeedBlur / setFlash 两条驱动路径都要同步
    expect(s).toContain('this.syncBlurEnabled();');
    // 回滚钩子
    expect(s).toContain('r49blurpass=off');
  });

  it('prewarm 期间强制 enabled=true（否则 program 不被编译，破坏 R42-P1）', () => {
    const s = src(POSTFX);
    const prewarm = s.slice(s.indexOf('prewarm(): void {'));
    expect(prewarm).toContain('const prevBlurEnabled = this.blurPass.enabled;');
    expect(prewarm).toContain('this.blurPass.enabled = true;');
    expect(prewarm).toContain('this.blurPass.enabled = prevBlurEnabled;');
    // 强制启用必须发生在 composer.render() 之前
    expect(prewarm.indexOf('this.blurPass.enabled = true;')).toBeLessThan(
      prewarm.indexOf('this.composer.render();')
    );
  });

  it('bug 回归：两处 Game 每帧驱动点都同时写 strength 与 flash（开关依据才完整）', () => {
    const g = src(GAME);
    // 自由探索 + 挑战两条路径
    expect(g).toContain('this.postfx.setSpeedBlur(freeBlur');
    expect(g).toContain('this.postfx.setFlash(0);');
    expect(g).toContain('this.postfx.setSpeedBlur(speedBlur');
    expect(g).toContain('this.postfx.setFlash(this.brakeFlash);');
    // brakeFlash 0.85 衰减段必须继续喂给 setFlash（否则衰减期 pass 被提前关掉）
    expect(g).toContain('this.brakeFlash = Math.max(0, this.brakeFlash - dt * 2.2);');
  });
});

describe('R49 · 铁律守卫（R39 阴影抖动闸门不得复活）', () => {
  it('Game.ts 不得重新引入「按车速」的阴影节流（R39 铁律）', () => {
    const g = codeOnly(src(GAME));
    // 唯一允许的 autoUpdate=false 是 DEV-only 的 #noshadowupd QA 冻结钩子
    // （Game.ts:475，用来精确量阴影单价；非运行时路径）。逐行校验，别的都不许有。
    const hits = g
      .split('\n')
      .filter((line) => line.includes('shadowMap.autoUpdate = false'));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("includes('noshadowupd')");
    // 节流配置项不得回归
    expect(g).not.toContain('shadowUpdateInterval');
    expect(g).not.toMatch(/jumpSq\s*=/);
    expect(g).not.toMatch(/speed\s*>\s*8\s*\)\s*\{/);
  });

  it('Lighting 仍是每帧重绘（autoUpdate=true），阴影无节流', () => {
    const l = codeOnly(src('src/render/scene/Lighting.ts'));
    expect(src('src/render/scene/Lighting.ts')).toContain('sun.shadow.autoUpdate = true;');
    expect(l).not.toContain('sun.shadow.autoUpdate = false;');
  });

  it('两块 R49 回滚钩子字面量成对存在', () => {
    expect(src(SHELL)).toContain('r49shadowproxy=off');
    expect(src(POSTFX)).toContain('r49blurpass=off');
  });
});
