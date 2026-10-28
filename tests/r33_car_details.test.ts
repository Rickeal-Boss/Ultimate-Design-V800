/**
 * R33 · 车辆精修回归
 *
 * 锁两件在装配层新增、但容易被后续重产/合批静默破坏的契约：
 *  1. R7 前脸手作件真实产出 7 个材质桶（灯腔/镀铬/镜片/透镜/DRL/格栅/前唇），
 *     三角数在预算内，且旧灯组隐藏清单覆盖 headlamp/lamp-edging/light-bar；
 *  2. V800 轮毂 18 窗开口放大后仍严格落在窗带内外缘内（0.203..0.283），
 *     不越界切穿抛光外唇（否则侧视会读成轮圈破洞）。
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createR7FrontDetails,
  R7_FRONT_DETAIL_MATERIAL_IDS,
  lipBarBounds,
  R7_FASCIA_BOTTOM_Y,
  R7_LIP_CONTACT_EPSILON
} from '../src/model/parts/r7FrontDetails';
import { createWheelHubResult, listWheelWindows, N_WINDOWS } from '../src/model/parts/wheelHub';

const triOf = (g: THREE.BufferGeometry): number => {
  const idx = g.getIndex();
  return (idx ? idx.count : g.getAttribute('position').count) / 3;
};

describe('R33 R7 前脸手作件', () => {
  const detail = createR7FrontDetails();

  it('生成 7 个材质桶，三角数在 1k–12k（首建不限时，运行仍受控）', () => {
    const ids = new Set<string>();
    let tris = 0;
    for (const mesh of detail.group.children as THREE.Mesh[]) {
      const m = mesh.material as THREE.Material;
      ids.add(String(m.userData?.sculptMaterial?.id ?? ''));
      tris += triOf(mesh.geometry);
    }
    expect([...ids].sort()).toEqual(Object.values(R7_FRONT_DETAIL_MATERIAL_IDS).sort());
    expect(tris).toBe(detail.triangleCount);
    expect(tris).toBeGreaterThan(1_000);
    expect(tris).toBeLessThan(12_000);
  });

  it('灯腔/下格栅处于前脸外侧，不埋进 front-fascia（z≈2.405）', () => {
    detail.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(detail.group);
    expect(box.min.z).toBeGreaterThan(2.40);
    expect(box.max.z).toBeLessThan(2.50);
    expect(box.max.x - box.min.x).toBeGreaterThan(1.7);
    expect(box.max.y).toBeLessThan(0.95);
  });

  it('旧灯组与旧发光刃全部在隐藏清单（防双白线/矩形黑卡复现）', () => {
    for (const id of [
      'headlamp-l',
      'headlamp-r',
      'lamp-edging-l',
      'lamp-edging-r',
      'light-bar-front'
    ]) {
      expect(detail.hiddenComponentIds).toContain(id);
    }
  });

  it('R34 前唇压条顶面贴合 front-fascia 底缘（零悬浮缝），且与本体 z 重叠', () => {
    const b = lipBarBounds();
    // 顶面对齐 fascia 底缘 y=0.21（容差 6mm ≈ 屏幕 1px 以下）
    expect(b.topGap).toBeLessThanOrEqual(R7_LIP_CONTACT_EPSILON);
    // 与 fascia 实体搭接 ≥18mm（企口对接会让悬浮态在几何上不可能发生）
    expect(b.zOverlap).toBeGreaterThan(0.018);
    // 端头封口埋进本体 ⇒ 压条整体 y 上限 ≥ fascia 底缘（确认不悬空）
    expect(b.capMaxY).toBeGreaterThanOrEqual(R7_FASCIA_BOTTOM_Y - 1e-6);
    // 压条处于前脸外侧 z 区间（不埋进车体，也不外探过多）
    expect(b.barMaxZ).toBeGreaterThan(2.4);
    expect(b.barMinZ).toBeLessThan(2.47);
  });
});

describe('R33 V800 轮毂开口', () => {
  it('18 窗放大后外接半径仍 < 窗带外缘 0.283（不切穿外唇）', () => {
    const rows = listWheelWindows();
    expect(rows).toHaveLength(N_WINDOWS);
    for (const w of rows) {
      expect(w.rOut).toBeLessThan(0.283);
      expect(w.rIn).toBeGreaterThan(0.203);
      expect(w.halfAngleDeg).toBeGreaterThan(7);
    }
  });

  it('轮毂 5 材质桶（R36-B1：制动盘拆 steel 独立档），bbox 半径不超过 0.3m', () => {
    const hub = createWheelHubResult(1);
    expect(hub.materials.bright.userData.sculptMaterial.id).toBe('r22-hub-bright');
    // R36-B1：制动盘独立金属灰语义（rough 0.4），不再并入近黑 dark
    const steel = hub.materials.steel;
    expect(steel.userData.sculptMaterial.id).toBe('r22-hub-steel');
    expect(steel.roughness).toBeGreaterThanOrEqual(0.35);
    expect(steel.roughness).toBeLessThanOrEqual(0.45);
    expect(steel.metalness).toBeGreaterThan(0.7);
    // steel 与 dark 亮度可分（盘不再被暗腔吞没）：steel 明度显著高于 dark
    const lum = (m: THREE.MeshStandardMaterial): number =>
      (m.color.r + m.color.g + m.color.b) / 3;
    expect(lum(steel)).toBeGreaterThan(lum(hub.materials.dark) + 0.3);
    // 盘几何在 steel 桶（mesh 名 = 材质 id）
    hub.group.updateMatrixWorld(true);
    const names = new Set<string>();
    hub.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) names.add(m.name);
    });
    expect(names.has('r22-hub-steel')).toBe(true);
    const box = new THREE.Box3().setFromObject(hub.group);
    expect(box.max.y - box.min.y).toBeLessThanOrEqual(0.601);
    expect(hub.triangleCount).toBeGreaterThan(1_200);
    hub.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  });

  it('D1 共聚面断言：bbox 同侧面距 <1mm 的件对，其材质必须开 polygonOffset（报警）', async () => {
    const { createZunjieV800LuxuryMPVModel } = await import('../src/model/createV800Model');
    const model = createZunjieV800LuxuryMPVModel();
    model.updateMatrixWorld(true);
    const boxes = new Map<string, { box: THREE.Box3; mat: THREE.Material | null }>();
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const id = String(m.userData?.sculptComponent?.id ?? m.name);
      const bb = new THREE.Box3().setFromObject(m);
      const prev = boxes.get(id);
      if (prev) prev.box.union(bb);
      else boxes.set(id, { box: bb, mat: (m.material as THREE.Material) ?? null });
    });
    const trimIds = [...boxes.keys()].filter((i) => /chrome-belt|window-belt|trim/.test(i));
    const skinIds = [...boxes.keys()].filter((i) => /body-lower|body-upper|door-panel$/.test(i));
    const offenders: string[] = [];
    for (const a of trimIds) {
      for (const b of skinIds) {
        const A = boxes.get(a)!;
        const B = boxes.get(b)!;
        const gaps = [
          Math.abs(A.box.max.x - B.box.max.x), Math.abs(A.box.min.x - B.box.min.x),
          Math.abs(A.box.max.y - B.box.max.y), Math.abs(A.box.min.y - B.box.min.y),
          Math.abs(A.box.max.z - B.box.max.z), Math.abs(A.box.min.z - B.box.min.z)
        ];
        if (Math.min(...gaps) < 0.001) {
          // 共聚面报警：材质必须带 polygonOffset 缓解（工厂 chrome 已由适配层补上）
          const mats = [A.mat, B.mat].filter(Boolean) as THREE.MeshPhysicalMaterial[];
          const mitigated = mats.every((m) => m.polygonOffset === true);
          if (!mitigated) offenders.push(`${a} ↔ ${b}`);
        }
      }
    }
    expect(offenders, `共聚面未缓解：${offenders.join(', ')}`).toEqual([]);
    /* ── R37 收尾 · 显式 timeout 15s（**不是**判据松弛）─────────────────────────
     * 症状：全量跑时本条 5s 超时（默认 testTimeout），但 **standalone 只需 2.4s**。
     * 归因（实测，非推测）：本条要在测试体内 `await import()` + **构建整台 V800
     * 车模**（createZunjieV800LuxuryMPVModel），是全仓最重的一条；全量跑时 vitest
     * 并行多个 worker，CPU 争用把它从 2.4s 推到 >5s。
     * ⇒ 属**环境 flake**（调度/争用），不是判据失效：
     *   · 断言本身**一字未改**（共聚面 ↔ polygonOffset 判据原样保留）；
     *   · `vite.config.ts` 的全局 testTimeout **不动**（不给其他测试开口子）；
     *   · 只给**这一条**显式 15s —— 相对 standalone 2.4s 有 6× 余量，相对全量实测
     *     5.2~5.6s 有 ~2.7× 余量。
     * 若将来本条在 15s 下仍红 ⇒ 那不再是争用问题，须回头查车模构建本身是否变重。 */
  }, 15_000);
});
