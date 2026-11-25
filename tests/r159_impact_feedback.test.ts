/**
 * R159 建筑撞击反馈：强度分档撞击点火花（自由探索撞墙/撞主殿）。
 *
 * 形态：fx/index.ts 无 window/DOM 链（r51_perf 已直接 node 实例化 Sparks/FxSystems），
 * 故做**真实运行时单测**（分档纯函数 + 粒子池 count 缩放），Game.ts 接线另加源契约
 * （Game.ts 顶层 await + window 依赖无法 node 实例化，与 r44_frame/r51_perf 同模式）。
 *
 * 判据：
 *   ① impactSparkParams 分档（纯函数）：轻擦<0.15→null（无粒子，防掠擦刷屏）、
 *      中撞 0.15≤s<0.6 随强度单调缩放、重撞≥0.6 满幅（hall 全池 96 + 更快更散）；
 *   ② hall（撞主殿）> wall（撞墙）同级更重（count/speed ≥）；
 *   ③ Sparks.burst(opts.count) 只激活 count 个粒子（aAlpha 可观测）、默认全池、
 *      count 钳到 [1, 池容量]；
 *   ④ FxSystems.burstSparks(opts) 透传（additive 火花 Points 可见性状态机）；
 *   ⑤ Game.ts 接线：onFreeEvent 走 impactSparkParams → burstSparks（防接线丢失）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FxSystems, Sparks, impactSparkParams } from '../src/fx';

const gameSrc = readFileSync(new URL('../src/core/Game.ts', import.meta.url), 'utf8');

describe('R159 建筑反馈 · impactSparkParams 分档（纯函数）', () => {
  it('轻擦 <0.15 无粒子（含边界 0.149 / 负值归 0）', () => {
    expect(impactSparkParams('wall', 0)).toBeNull();
    expect(impactSparkParams('wall', 0.1)).toBeNull();
    expect(impactSparkParams('wall', 0.14)).toBeNull();
    expect(impactSparkParams('wall', 0.149)).toBeNull();
    expect(impactSparkParams('hall', 0.14)).toBeNull();
    expect(impactSparkParams('wall', -1)).toBeNull();
  });

  it('中撞 0.15≤s<0.6 非空且随强度单调增（wall）', () => {
    const a = impactSparkParams('wall', 0.15)!;
    const b = impactSparkParams('wall', 0.5)!;
    const c = impactSparkParams('wall', 0.59)!;
    expect(a).not.toBeNull();
    expect(a.count).toBeGreaterThan(0);
    expect(a.speed).toBeGreaterThan(0);
    expect(b.count).toBeGreaterThan(a.count); // 单调增
    expect(c.count).toBeGreaterThan(b.count);
  });

  it('重撞 ≥0.6 满幅（hall 全池 96 + 更快更散；wall 也到重档且 ≤96）', () => {
    const hall = impactSparkParams('hall', 0.6)!;
    const full = impactSparkParams('hall', 1.0)!;
    expect(hall.count).toBe(96);
    expect(full.count).toBe(96);
    expect(hall.speed).toBe(1.25);
    expect(hall.spread).toBe(1.2);
    const w = impactSparkParams('wall', 1.0)!;
    expect(w.count).toBeGreaterThan(60);
    expect(w.count).toBeLessThanOrEqual(96);
    expect(w.speed).toBeGreaterThan(1);
  });

  it('hall 同级更重（count/speed 均 ≥ wall，跨三档抽样）', () => {
    for (const s of [0.15, 0.2, 0.4, 0.6, 0.7, 1.0]) {
      const hall = impactSparkParams('hall', s)!;
      const wall = impactSparkParams('wall', s)!;
      expect(hall.count).toBeGreaterThanOrEqual(wall.count);
      expect(hall.speed).toBeGreaterThanOrEqual(wall.speed);
    }
  });

  it('强度 clamp 到 [0,1]（>1 与 =1 同档）', () => {
    expect(impactSparkParams('hall', 2.0)).toEqual(impactSparkParams('hall', 1.0));
    expect(impactSparkParams('wall', 3.0)).toEqual(impactSparkParams('wall', 1.0));
  });
});

describe('R159 建筑反馈 · Sparks.burst 强度缩放（运行时）', () => {
  /** 跑一帧 update 后统计 aAlpha>0 的活粒子数（死槽 update 置 alpha=0） */
  function aliveCount(sparks: Sparks, dt = 0.016): number {
    sparks.update(dt);
    const alpha = sparks.object.geometry.getAttribute('aAlpha').array as Float32Array;
    let n = 0;
    for (let i = 0; i < alpha.length; i++) if (alpha[i] > 0) n++;
    return n;
  }

  it('默认（无 opts）激活全池', () => {
    const sparks = new Sparks(8);
    sparks.burst(new THREE.Vector3());
    expect(aliveCount(sparks)).toBe(8);
    sparks.dispose();
  });

  it('opts.count 只激活 count 个（8 池 count:3 → 3 活 5 死）', () => {
    const sparks = new Sparks(8);
    sparks.burst(new THREE.Vector3(), { count: 3 });
    expect(aliveCount(sparks)).toBe(3);
    sparks.dispose();
  });

  it('opts.count 钳到池容量（count:100 → 8）与下限 1（count:0 → 1）', () => {
    const s1 = new Sparks(8);
    s1.burst(new THREE.Vector3(), { count: 100 });
    expect(aliveCount(s1)).toBe(8);
    s1.dispose();
    const s2 = new Sparks(8);
    s2.burst(new THREE.Vector3(), { count: 0 });
    expect(aliveCount(s2)).toBe(1);
    s2.dispose();
  });

  it('clear 复位 visible=false', () => {
    const sparks = new Sparks(8);
    sparks.burst(new THREE.Vector3());
    sparks.update(0.016);
    expect((sparks.object as THREE.Points).visible).toBe(true);
    sparks.clear();
    sparks.update(0.016);
    expect((sparks.object as THREE.Points).visible).toBe(false);
    sparks.dispose();
  });
});

describe('R159 建筑反馈 · FxSystems.burstSparks 透传', () => {
  it('opts 透传并激活火花 Points（scene 可见性状态机）', () => {
    const scene = new THREE.Scene();
    const fx = new FxSystems(scene, 'high');
    // 定位火花 Points（AdditiveBlending 唯一标识；烟是 NormalBlending）
    const pts = scene.children.find(
      (c) =>
        (c as THREE.Points).isPoints &&
        (c as THREE.Points).material.blending === THREE.AdditiveBlending
    ) as THREE.Points;
    expect(pts).toBeDefined();
    expect(pts.visible).toBe(false);
    fx.burstSparks(new THREE.Vector3(), { count: 3 });
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

describe('R159 建筑反馈 · Game.ts 接线源契约', () => {
  it('onFreeEvent 走 impactSparkParams → burstSparks（防接线丢失）', () => {
    expect(gameSrc).toContain('impactSparkParams');
    expect(gameSrc).toContain('const spark = impactSparkParams(e.kind, s);');
    expect(gameSrc).toContain('this.fx.burstSparks(hit, spark);');
    expect(gameSrc).toContain('this.car.root.localToWorld(new THREE.Vector3(0, 0.6, -2.7))');
    // R110 满幅基线不回归（音效/震屏保持连续强度缩放）
    expect(gameSrc).toContain('this.rig.addShake(0.32 * s);');
    expect(gameSrc).toContain('this.rig.addShake(0.12 * s);');
  });
});
