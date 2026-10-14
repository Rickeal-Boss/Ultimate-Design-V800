/**
 * WebGLRenderer + 质量档。
 * antialias 按 quality、pixelRatio ≤ 2、ACESFilmic exposure 0.85、
 * SRGB 输出、PCF 阴影。
 * 注：three r186 已移除 PCFSoftShadowMap（运行时警告并强制回退 PCFShadowMap，
 * 见 WebGLShadowMap.js），故直接显式使用 PCFShadowMap，消除控制台警告。
 */
import * as THREE from 'three';
import type { QualitySettings } from '../config/quality';

export function createRenderer(container: HTMLElement, quality: QualitySettings): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: quality.antialias,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  return renderer;
}
