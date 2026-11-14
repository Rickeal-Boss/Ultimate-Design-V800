/**
 * 合并几何体的安全封装。
 * THREE.mergeGeometries 要求所有输入要么全部带 index、要么全部不带；
 * Box/Sphere/Cylinder 等 indexed 与 Extrude/Lathe 等 non-indexed 混拼时会返回 null
 * （运行时报 "All geometries must have compatible attributes"）。统一转 non-indexed 再合并。
 *
 * ══ R81 P0-1 · 空数组防御（用户「R7 无法进入」）══════════════════════════════
 * three 的 `mergeGeometries([])` 内部读 `geometries[0].index` ⇒ 抛
 * `TypeError: Cannot read properties of undefined (reading 'index')`。
 * R80 把 R7 侧贴默认关闭后 `sideQuads=[]`，而 `r7TailWrap.ts` 仍无条件
 * `mergeSafe(sideQuads)` ⇒ `loadExternalShell` catch 把 r44ShellStatus[car] 置 failed
 * ⇒ R66-D 原子回滚 ⇒ 默认路径只剩 82 件程序化低模（31,250 tri）。
 * 此处统一判空，防御**所有**调用方（别的 parts 也可能踩）；返回空 BufferGeometry，
 * 不触碰 normalized 的 dispose 语义：调用方仍只对传入的原 geos 调 dispose，
 * 空数组时没有任何对象需要释放，也不产生额外 normalized 实例。
 * 回滚：`#r81mergeempty=off` ⇒ 逐位回 R80 旧行为（A/B 复现异常）。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** 空数组 guard 开关（默认 ON；node / SSR 无 window ⇒ 同样 ON，护栏可复现）。 */
const R81_MERGE_EMPTY_GUARD: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r81mergeempty=off/i.test(window.location.hash);

export function mergeSafe(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (R81_MERGE_EMPTY_GUARD && geos.length === 0) return new THREE.BufferGeometry();
  const normalized = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(normalized);
  if (!merged) throw new Error('mergeGeometries failed: incompatible geometry attributes');
  return merged;
}
