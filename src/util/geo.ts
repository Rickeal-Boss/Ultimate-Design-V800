/**
 * 合并几何体的安全封装。
 * THREE.mergeGeometries 要求所有输入要么全部带 index、要么全部不带；
 * Box/Sphere/Cylinder 等 indexed 与 Extrude/Lathe 等 non-indexed 混拼时会返回 null
 * （运行时报 "All geometries must have compatible attributes"）。统一转 non-indexed 再合并。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function mergeSafe(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(normalized);
  if (!merged) throw new Error('mergeGeometries failed: incompatible geometry attributes');
  return merged;
}
