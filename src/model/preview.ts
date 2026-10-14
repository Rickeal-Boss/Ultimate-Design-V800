/**
 * img2threejs 审查渲染页（仅 dev 使用；vite build 不含此入口）。
 * window.__v800Capture(name, azimuthDeg, pitchDeg, distance, targetY) → dataURL
 */
import * as THREE from 'three';
import {
  createZunjieV800LuxuryMPVModel,
  createZunjieV800LuxuryMPVLookDevLights,
  createZunjieV800LuxuryMPVEnvironment,
  frameZunjieV800LuxuryMPVCamera,
  configureZunjieV800LuxuryMPVRenderer,
} from './createV800Model';

declare global {
  interface Window {
    __v800Capture: (name: string, azimuthDeg?: number, pitchDeg?: number, distance?: number, targetYOffset?: number) => string;
    __v800Info: () => { tris: number; calls: number; box: number[] };
  }
}

const stage = document.getElementById('stage') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(1280, 760);
renderer.setPixelRatio(1);
configureZunjieV800LuxuryMPVRenderer(renderer);
renderer.toneMappingExposure = 0.9;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x241a1e);
scene.environment = createZunjieV800LuxuryMPVEnvironment(renderer);

const camera = new THREE.PerspectiveCamera(30, 1280 / 760, 0.05, 60);
scene.add(createZunjieV800LuxuryMPVLookDevLights());

const model = createZunjieV800LuxuryMPVModel({ textureSize: 1024 });
scene.add(model);
// 隐藏纯容器组件的实体占位箱（root/cabin-interior 仅为层级容器，无视觉体）
const CONTAINER_IDS = new Set(['root', 'cabin-interior']);
model.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) {
    const cid = o.userData.sculptComponent?.id as string | undefined;
    if (cid && CONTAINER_IDS.has(cid)) o.visible = false;
  }
});
model.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(model);
const center = box.getCenter(new THREE.Vector3());
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(9, 48),
  new THREE.MeshStandardMaterial({ color: 0x2c2226, roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = center.y - box.getSize(new THREE.Vector3()).y / 2 + 0.001;
// 地面盘移除：避免污染轮廓分割（审查用纯背景）

frameZunjieV800LuxuryMPVCamera(camera, model);
renderer.render(scene, camera);
status.textContent = 'ready';

window.__v800Capture = (
  name: string,
  azimuthDeg = 90,
  pitchDeg = 8,
  distance = 9.0,
  targetYOffset = 0,
  stripped = false
): string => {
  if (stripped) {
    // map-stripped 证据：全模型换无光照白色材质 + 纯色背景（一次性切换）
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !/collider/i.test(m.name)) {
        const cid = m.userData.sculptComponent?.id as string | undefined;
        if (cid && (cid === 'root' || cid === 'cabin-interior')) m.visible = false;
        m.material = strippedMaterial;
      }
    });
    scene.background = new THREE.Color(0x000000);
    scene.remove(ground);
  }
  const az = (azimuthDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const ty = center.y + targetYOffset;
  const target = new THREE.Vector3(0, ty, 0);
  camera.position.set(
    target.x + distance * Math.cos(pitch) * Math.sin(az),
    target.y + distance * Math.sin(pitch),
    target.z + distance * Math.cos(pitch) * Math.cos(az)
  );
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  status.textContent = `captured:${name}`;
  return renderer.domElement.toDataURL('image/png');
};

const strippedMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

window.__v800Info = (): { tris: number; calls: number; box: number[] } => {
  renderer.render(scene, camera);
  const info = renderer.info;
  const size = box.getSize(new THREE.Vector3());
  return { tris: info.render.triangles, calls: info.render.calls, box: [size.x, size.y, size.z] };
};

declare global {
  interface Window {
    __v800Parts: () => Array<{ id: string; size: number[]; pos: number[]; scale: number[]; worldMin?: number[]; worldPos?: number[] }>;
  }
}
window.__v800Parts = (): Array<{ id: string; size: number[]; pos: number[]; scale: number[] }> => {
  const rows: Array<{ id: string; size: number[]; pos: number[]; scale: number[]; worldMin?: number[]; worldPos?: number[] }> = [];
  model.updateWorldMatrix(true, true);
  model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.sculptComponent) {
      const b = new THREE.Box3().setFromObject(o);
      const s = b.getSize(new THREE.Vector3());
      const wp = o.getWorldPosition(new THREE.Vector3());
      const wb = new THREE.Box3().setFromObject(o);
      rows.push({
        id: String(o.userData.sculptComponent.id),
        size: [s.x, s.y, s.z].map((v) => Math.round(v * 1000) / 1000),
        worldMin: [wb.min.x, wb.min.y, wb.min.z].map((v) => Math.round(v * 1000) / 1000),
        worldPos: [wp.x, wp.y, wp.z].map((v) => Math.round(v * 1000) / 1000),
        pos: [o.position.x, o.position.y, o.position.z].map((v) => Math.round(v * 1000) / 1000),
        scale: [o.scale.x, o.scale.y, o.scale.z],
      });
    }
  });
  return rows;
};
