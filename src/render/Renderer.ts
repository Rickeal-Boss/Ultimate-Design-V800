/**
 * WebGLRenderer + 质量档。
 * antialias 按 quality、pixelRatio ≤ 2、ACESFilmic exposure 0.85、
 * SRGB 输出、PCFSoft 阴影（不用任何已废弃 API）。
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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  return renderer;
}
