/**
 * img2threejs 审查渲染页（仅 dev 使用；vite build 不含此入口）。
 * window.__v800Capture(name, azimuthDeg, pitchDeg, distance, targetY) → dataURL
 * window.__v800CaptureCabin(name, row:'front'|'rear'|'third', opts?) → dataURL
 *   —— 座舱内视捕获（QA 基线用）：按组件 ID 隐藏外壳、保留舱内件，相机置于对应座椅视点，
 *      锚点由 seat-* 组件世界包围盒实测推导（三排未建模时沿前→后排步长外推）。
 *   opts: { zoom?: 向注视点推进系数(0.2..1，默认1); yawDeg?: 相对默认朝向偏航; pitchDeg?: 覆盖默认俯角 }
 * hash #cabin=front|rear|third：页面加载即渲染该座舱机位（外壳隐藏，供人工审查）。
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

/* ------------------------------------------------------------------ */
/* 座舱内视捕获（QA 基线 / 人工审查；2026-10-16 新增）                   */
/* 车头朝 +Z（spec coordinateFrame），左舵驾驶位在 +X 侧。               */
/* ------------------------------------------------------------------ */

type CabinRow = 'front' | 'rear' | 'third';

declare global {
  interface Window {
    __v800CaptureCabin: (
      name: string,
      row: CabinRow,
      opts?: { zoom?: number; yawDeg?: number; pitchDeg?: number },
    ) => string;
  }
}

/** 外壳组件 ID 模式（座舱视图隐藏）；pillar- 为子串匹配（覆盖 dpillar/bpillar/cpillar） */
const CABIN_HIDE_RE =
  /^(body-|hood-|greenhouse-|roof-|windshield|front-end|chrome-brow|maextro-mark|shield-logo|headlamp-|bumper-|front-plate|tailgate|taillamp-|lantern-|tail-window-trim|tail-chrome-strip|chrome-belt-|window-belt-|handle-|fender-|rocker-|mirror-|fuel-door|arch-|lidar-|wheel-|tire-|rim-|cap-|emblem-|front-light-bar|rear-reflector-)|pillar-/;
/** 舱内组件 ID 模式（座舱视图保留）；未知 ID 默认保留，防止后续新增内饰件被误藏 */
const CABIN_KEEP_RE =
  /^(seat-|dash-|.+-screen|steering|tunnel-|crystal-|charge-pad|cupholder-|headliner-|overhead-|ambient-|door-panel-|speaker-|tweeter-|curtain-|starlight-|vent|cabin-floor|carpet|console-|armrest|sconce|reading-|sunshade|fridge|table-|tray-)/;

/** 座舱视图中该组件是否可见（纯容器占位箱恒隐藏） */
const cabinMeshVisible = (id: string): boolean => {
  if (CONTAINER_IDS.has(id)) return false;
  if (CABIN_KEEP_RE.test(id)) return true;
  return !CABIN_HIDE_RE.test(id);
};

/** 切换外壳可见性；返回被改动的 mesh 列表（容器占位箱不动） */
const setCabinShellVisible = (visible: boolean): THREE.Object3D[] => {
  const touched: THREE.Object3D[] = [];
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const cid = m.userData.sculptComponent?.id as string | undefined;
    if (cid && !CONTAINER_IDS.has(cid) && !cabinMeshVisible(cid)) {
      o.visible = visible;
      touched.push(o);
    }
  });
  return touched;
};

/** 收集匹配前缀的舱内组件世界包围盒（union；多 mesh 组件也合并） */
const cabinBox = (prefixes: string[]): THREE.Box3 | null => {
  model.updateMatrixWorld(true);
  let acc: THREE.Box3 | null = null;
  for (const p of prefixes) {
    // 闭包内累加：用显式窄化绕过 TS 对「仅闭包内赋值」变量的 never 收窄
    let found: THREE.Box3 | null = null;
    const hit = (b: THREE.Box3): void => {
      found = found === null ? b : (found as THREE.Box3).union(b);
    };
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || found !== null) return;
      const cid = m.userData.sculptComponent?.id as string | undefined;
      if (cid && cid.startsWith(p)) hit(new THREE.Box3().setFromObject(m));
    });
    const f = found as THREE.Box3 | null;
    if (f !== null && !f.isEmpty()) acc = acc === null ? f : (acc as THREE.Box3).union(f);
  }
  return acc;
};

/** 座椅实测缺失时的兜底锚点（任务给定口径，单位 m） */
const CABIN_FALLBACK: Record<CabinRow, [number, number, number]> = {
  front: [0, 1.15, 0.4],
  rear: [0, 1.15, -0.9],
  third: [0, 1.1, -2.2],
};

/** 由 seat-* 世界包围盒推导视点（眼高≈座底+0.80m，前视+0.30m / 后视-0.30m） */
const cabinEye = (row: CabinRow): THREE.Vector3 => {
  const front = cabinBox(['seat-driver', 'seat-passenger']);
  const rear = cabinBox(['seat-rear-l', 'seat-rear-r']);
  const third = cabinBox(['seat-third']);
  const v = new THREE.Vector3();
  if (row === 'front' && front) {
    // eye 锚点用座椅中心 +0.15m：原 max.z + 0.3 ≈ 1.474 落进 dash（z 1.25..1.55）内部，POV 被仪表台剖切
    return v.set(front.getCenter(new THREE.Vector3()).x, front.min.y + 0.8, front.getCenter(new THREE.Vector3()).z + 0.15);
  }
  if (row === 'rear' && rear) {
    return v.set(rear.getCenter(new THREE.Vector3()).x, rear.min.y + 0.82, rear.min.z - 0.3);
  }
  if (row === 'third') {
    if (third) {
      return v.set(third.getCenter(new THREE.Vector3()).x, third.min.y + 0.78, third.min.z - 0.3);
    }
    // 三排尚未建模：沿「前→后排」纵向步长外推（rearZ + step）
    if (rear && front) {
      const frontZ = front.max.z + 0.3;
      const rearZ = rear.min.z - 0.3;
      return v.set(rear.getCenter(new THREE.Vector3()).x, rear.min.y + 0.78, rearZ + (rearZ - frontZ));
    }
  }
  const [x, y, z] = CABIN_FALLBACK[row];
  return v.set(x, y, z);
};

/** 座舱机位：FOV 55（舱内广角），视点→注视点 3.5m */
const applyCabinCamera = (row: CabinRow, opts?: { zoom?: number; yawDeg?: number; pitchDeg?: number }): void => {
  const sign = row === 'front' ? 1 : -1;
  const dir = new THREE.Vector3(0, sign > 0 ? -0.12 : -0.1, sign);
  if (opts?.pitchDeg !== undefined) {
    const p = (opts.pitchDeg * Math.PI) / 180;
    dir.set(0, Math.sin(p), sign * Math.cos(p));
  }
  if (opts?.yawDeg) dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (opts.yawDeg * Math.PI) / 180);
  dir.normalize();
  const zoom = Math.min(Math.max(opts?.zoom ?? 1, 0.2), 1);
  const eye = cabinEye(row).addScaledVector(dir, (1 - zoom) * 1.2);
  camera.fov = 55;
  // frameZunjieV800LuxuryMPVCamera 会把 near 提到 ≈5.58m（=distance−maxDim）且永久生效；
  // 座舱 POV 距座椅 0.3–0.5m，全几何被近截面裁掉（0 calls/0 tris）→ 舱内机位必须恢复构造值
  camera.near = 0.05;
  camera.far = 60;
  camera.position.copy(eye);
  camera.lookAt(eye.clone().addScaledVector(dir, 3.5));
  camera.updateProjectionMatrix();
};

window.__v800CaptureCabin = (
  name: string,
  row: CabinRow,
  opts?: { zoom?: number; yawDeg?: number; pitchDeg?: number },
): string => {
  const hidden = setCabinShellVisible(false);
  const prevFov = camera.fov;
  applyCabinCamera(row, opts);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  for (const o of hidden) o.visible = true;
  camera.fov = prevFov;
  camera.updateProjectionMatrix();
  status.textContent = `captured-cabin:${name}`;
  return url;
};

/** #cabin=front|rear|third hash：加载即渲染该座舱机位（外壳保持隐藏，供人工审查） */
const CABIN_HASH_RE = /cabin=(front|rear|third)/;
let cabinHashHidden: THREE.Object3D[] = [];
const applyCabinHash = (): void => {
  for (const o of cabinHashHidden) o.visible = true;
  cabinHashHidden = [];
  const m = CABIN_HASH_RE.exec(window.location.hash);
  if (!m) return;
  cabinHashHidden = setCabinShellVisible(false);
  applyCabinCamera(m[1] as CabinRow);
  renderer.render(scene, camera);
  status.textContent = `cabin:${m[1]}（外壳已隐藏·人工审查；去掉 hash 刷新恢复整车）`;
};
applyCabinHash();
window.addEventListener('hashchange', applyCabinHash);
