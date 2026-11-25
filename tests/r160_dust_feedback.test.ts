/**
 * R160 建筑撞击反馈：撞击点扬尘 + 砖石碎片（自由探索撞墙/撞主殿）。
 *
 * 形态：fx/index.ts 无 window/DOM 链（r51_perf / r159 已直接 node 实例化
 * Sparks/FxSystems），故做**真实运行时单测**（分档纯函数 + 粒子池 count 缩放），
 * Game.ts 接线另加源契约（Game.ts 顶层 await + window 依赖无法 node 实例化，
 * 与 r159/r51_perf/r44_frame 同模式）。
 *
 * 判据：
 *   ① impactDustParams 分档（纯函数）：轻擦<0.15→null（无尘，防掠擦扬尘刷屏）、
 *      中撞 0.15≤s<0.6 纯尘（chunkRatio 0）+ 随强度单调缩放、重撞≥0.6 加碎片
 *      （hall chunkRatio 0.3 / wall chunkRatio 0.15）；
 *   ② hall（撞主殿）> wall（撞墙）同级更重（count/speed ≥）；
 *   ③ Dust.burst(opts.count/chunkRatio) 只激活 count 个粒子（aAlpha 可观测）、
 *      默认全池、count 钳到 [1, 池容量]；
 *   ④ FxSystems.burstDust(opts) 透传（dust Points 可见性状态机，NormalBlending
 *      + uColor=0x9a8c78 定位）；
 *   ⑤ Game.ts 接线：onFreeEvent 走 impactDustParams → burstDust（防接线丢失）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Dust, FxSystems, impactDustParams } from '../src/fx';

const gameSrc = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8');

describe('R160 建筑反馈 · impactDustParams 分档（纯函数）', () => {
  it('轻擦 <0.15 无尘（含边界 0.149 / 负值归 0）', () => {
    expect(impactDustParams('wall', 0)).toBeNull();
    expect(impactDustParams('wall', 0.1)).toBeNull();
    expect(impactDustParams('wall', 0.14)).toBeNull();
    expect(impactDustParams('wall', 0.149)).toBeNull();
    expect(impactDustParams('hall', 0.14)).toBeNull();
    expect(impactDustParams('wall', -1)).toBeNull();
  });

  it('中撞 0.15≤s<0.6 纯尘（chunkRatio 0）且 count 随强度单调增（wall / hall）', () => {
    for (const kind of ['wall', 'hall'] as const) {
      const a = impactDustParams(kind, 0.15)!;
      const b = impactDustParams(kind, 0.4)!;
      const c = impactDustParams(kind, 0.59)!;
      expect(a).not.toBeNull();
      expect(a.count).toBeGreaterThan(0);
      expect(a.speed).toBeGreaterThan(0);
      expect(a.chunkRatio).toBe(0); // 中撞纯尘，无碎片
      expect(b.chunkRatio).toBe(0);
      expect(c.chunkRatio).toBe(0);
      expect(b.count).toBeGreaterThan(a.count); // 单调增
      expect(c.count).toBeGreaterThan(b.count);
    }
  });

  it('重撞 ≥0.6 加碎片（hall count 120 + chunkRatio 0.3；wall chunkRatio 0.15）', () => {
    const hall = impactDustParams('hall', 0.6)!;
    const full = impactDustParams('hall', 1.0)!;
    expect(hall.count).toBe(120);
    expect(full.count).toBe(120);
    expect(hall.chunkRatio).toBe(0.3);
    expect(hall.speed).toBe(1.15);
    expect(hall.spread).toBe(1.2);
    const w = impactDustParams('wall', 1.0)!;
    expect(w.count).toBeGreaterThan(80);
    expect(w.count).toBeLessThanOrEqual(120);
    expect(w.chunkRatio).toBe(0.15);
    expect(w.speed).toBeGreaterThan(0.9);
  });

  it('hall 同级更重（count/speed 均 ≥ wall，跨三档抽样）', () => {
    for (const s of [0.15, 0.2, 0.4, 0.6, 0.7, 1.0]) {
      const hall = impactDustParams('hall', s)!;
      const wall = impactDustParams('wall', s)!;
      expect(hall.count).toBeGreaterThanOrEqual(wall.count);
      expect(hall.speed).toBeGreaterThanOrEqual(wall.speed);
    }
  });

  it('强度 clamp 到 [0,1]（>1 与 =1 同档）', () => {
    expect(impactDustParams('hall', 2.0)).toEqual(impactDustParams('hall', 1.0));
    expect(impactDustParams('wall', 3.0)).toEqual(impactDustParams('wall', 1.0));
  });
});

describe('R160 建筑反馈 · Dust.burst 强度缩放（运行时）', () => {
  /** 跑一帧 update 后统计 aAlpha>0 的活粒子数（死槽 update 置 alpha=0） */
  function aliveCount(dust: Dust, dt = 0.016): number {
    dust.update(dt);
    const alpha = dust.object.geometry.getAttribute('aAlpha').array as Float32Array;
    let n = 0;
    for (let i = 0; i < alpha.length; i++) if (alpha[i] > 0) n++;
    return n;
  }

  it('默认（无 opts）激活全池', () => {
    const dust = new Dust(8);
    dust.burst(new THREE.Vector3());
    expect(aliveCount(dust)).toBe(8);
    dust.dispose();
  });

  it('opts.count 只激活 count 个（8 池 count:3 → 3 活 5 死）', () => {
    const dust = new Dust(8);
    dust.burst(new THREE.Vector3(), { count: 3 });
    expect(aliveCount(dust)).toBe(3);
    dust.dispose();
  });

  it('opts.count 钳到池容量（count:100 → 8）与下限 1（count:0 → 1）', () => {
    const d1 = new Dust(8);
    d1.burst(new THREE.Vector3(), { count: 100 });
    expect(aliveCount(d1)).toBe(8);
    d1.dispose();
    const d2 = new Dust(8);
    d2.burst(new THREE.Vector3(), { count: 0 });
    expect(aliveCount(d2)).toBe(1);
    d2.dispose();
  });

  it('clear 复位 visible=false', () => {
    const dust = new Dust(8);
    dust.burst(new THREE.Vector3());
    dust.update(0.016);
    expect((dust.object as THREE.Points).visible).toBe(true);
    dust.clear();
    dust.update(0.016);
    expect((dust.object as THREE.Points).visible).toBe(false);
    dust.dispose();
  });
});

describe('R160 建筑反馈 · FxSystems.burstDust 透传', () => {
  it('opts 透传并激活尘 Points（scene 可见性状态机）', () => {
    const scene = new THREE.Scene();
    const fx = new FxSystems(scene, 'high');
    // 定位尘 Points：NormalBlending + uColor=0x9a8c78（唯一非烟色 NormalBlending；
    // 烟是 0xc4a49a NormalBlending，需按 uniforms.uColor.value 区分）
    const pts = scene.children.find(
      (c) =>
        (c as THREE.Points).isPoints &&
        (c as THREE.Points).material.blending === THREE.NormalBlending &&
        ((c as THREE.Points).material as THREE.ShaderMaterial).uniforms?.uColor?.value?.getHex?.() ===
          0x9a8c78
    ) as THREE.Points;
    expect(pts).toBeDefined();
    expect(pts.visible).toBe(false);
    fx.burstDust(new THREE.Vector3(), { count: 3 });
    fx.update(0.016, {
      carRoot: new THREE.Object3D(),
      brakeIntensity: 0,
      speedMs: 0,
      braking: false
    });
    expect(pts.visible).toBe(true);
    fx.clear();
    fx.update(0.016, {
      carRoot: new THREE.Object3D(),
      brakeIntensity: 0,
      speedMs: 0,
      braking: false
    });
    expect(pts.visible).toBe(false);
    fx.dispose();
  });
});

describe('R160 建筑反馈 · Game.ts 接线源契约', () => {
  it('onFreeEvent 走 impactDustParams → burstDust（防接线丢失）', () => {
    expect(gameSrc).toContain('impactDustParams');
    expect(gameSrc).toContain('const dust = impactDustParams(e.kind, s);');
    expect(gameSrc).toContain('this.fx.burstDust(hit, dust);');
    expect(gameSrc).toContain('this.car.root.localToWorld(new THREE.Vector3(0, 0.6, -2.7))');
    // 共用撞击点：spark / dust 走同一 if(spark || dust) 复合分支
    expect(gameSrc).toContain('if (spark || dust)');
    // R110 满幅基线不回归（音效/震屏保持连续强度缩放）
    expect(gameSrc).toContain('this.rig.addShake(0.32 * s);');
    expect(gameSrc).toContain('this.rig.addShake(0.12 * s);');
  });
});
