/**
 * V800 新工厂 → 游戏运行时适配器。
 * 将 img2threejs 生成的 createZunjieV800LuxuryMPVModel 包装为 Car 兼容接口：
 * root/body/wheels/灯光联动/悬浮轮标/动态仪表。
 * 车头朝向：游戏前进方向 -Z，新工厂车头 +Z → root 内置 rotY(PI) 中枢。
 */
import * as THREE from 'three';
import {
  createZunjieV800LuxuryMPVModel,
  type ProceduralModelRuntime,
} from './createV800Model';

export interface WheelPivot {
  /** 滚动旋转对象（绕 X 轴） */
  spin: THREE.Object3D;
}

export interface CarLike {
  readonly root: THREE.Group;
  /** 俯仰/翻转作用组（crash 时重置姿态） */
  readonly body: THREE.Group;
  readonly wheels: WheelPivot[];
  currentHeat: number;
  spinWheels(dist: number, dt: number): void;
  setBrakeLights(intensity: number): void;
  flashBrakeSnap(): void;
  setHeadlights(on: boolean): void;
  setBrakeHeat(t: number): void;
  updateCluster(speedKmh: number, forceN: number, g: number, gear: string): void;
  setSteer(angle: number): void;
  update(camera: THREE.Camera): void;
  dispose(): void;
}

const MS_TO_RPM_SCALE = 2.6; // 视觉轮速系数（车轮半径 0.382，弧度 = dist/r，视觉略放大）

export function createV800CarAdapter(): CarLike {
  const model = createZunjieV800LuxuryMPVModel({ textureSize: 1024 });
  const runtime = model.userData.runtime as ProceduralModelRuntime | undefined;

  const root = new THREE.Group();
  const body = new THREE.Group();
  body.rotation.y = Math.PI; // 车头 +Z → -Z（游戏前进方向）
  body.add(model);
  root.add(body);

  // ---- 节点索引 ----
  const byId = new Map<string, THREE.Object3D>();
  void runtime;
  model.traverse((o) => {
    const cid = (o.userData.sculptComponent?.id ?? o.userData.component?.id) as string | undefined;
    if (cid && !byId.has(cid)) byId.set(cid, o);
  });
  const meshMats = new Map<string, THREE.MeshStandardMaterial>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      const cid = (m.userData.sculptComponent?.id ?? o.userData.component?.id) as string | undefined;
      if (cid && !meshMats.has(cid)) {
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat && 'emissive' in mat) meshMats.set(cid, mat);
      }
    }
  });

  // 隐藏纯容器占位箱（root/cabin-interior 的实心盒）
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      const cid = (m.userData.sculptComponent?.id ?? o.userData.component?.id) as string | undefined;
      if (cid === 'root' || cid === 'cabin-interior') m.visible = false;
    }
  });

  // ---- 车轮（pivot 在轮心，绕 X 滚动）----
  const wheels: WheelPivot[] = [];
  for (const tag of ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr']) {
    const pivot = byId.get(tag);
    if (pivot) wheels.push({ spin: pivot });
  }

  // ---- 灯光材质 ----
  const tailMat = meshMats.get('lantern-core-l') ?? meshMats.get('lantern-core-r');
  const highMat = meshMats.get('high-mount-stop');
  const headMat = meshMats.get('headlamp-led-l') ?? meshMats.get('headlamp-led-r');
  const markMat = meshMats.get('maextro-mark');
  const TAIL_BASE = 2.0;
  const HEAD_BASE = 2.5;
  let brakeLevel = TAIL_BASE;
  let brakeTarget = TAIL_BASE;
  let headLevel = HEAD_BASE;
  let headTarget = HEAD_BASE;
  let snapT = 0;
  let heat = 0;

  // ---- 悬浮轮标 ----
  const caps: THREE.Object3D[] = [];
  for (const tag of ['cap-fl', 'cap-fr', 'cap-rl', 'cap-rr']) {
    const c = byId.get(tag);
    if (c) caps.push(c);
  }

  // ---- 动态仪表（gauge-screen CanvasTexture）----
  const gaugeCanvas = document.createElement('canvas');
  gaugeCanvas.width = 512;
  gaugeCanvas.height = 288;
  const gctx = gaugeCanvas.getContext('2d')!;
  const gaugeTex = new THREE.CanvasTexture(gaugeCanvas);
  gaugeTex.colorSpace = THREE.SRGBColorSpace;
  const gaugeNode = byId.get('gauge-screen');
  const gaugeMesh =
    gaugeNode && (gaugeNode as THREE.Mesh).isMesh
      ? (gaugeNode as THREE.Mesh)
      : (runtime?.meshes?.['gauge-screen'] as THREE.Mesh | undefined);
  if (gaugeMesh && gaugeMesh.material) {
    const mat = gaugeMesh.material as THREE.MeshStandardMaterial;
    mat.map = gaugeTex;
    mat.emissiveMap = gaugeTex;
    mat.emissive.set(0xffffff);
    mat.emissiveIntensity = 1.2;
    mat.color.set(0x0a0a0c);
    mat.needsUpdate = true;
  }
  let lastGaugeKey = '';
  const drawGauge = (speedKmh: number, forceN: number, g: number, gear: string): void => {
    const key = `${Math.round(speedKmh)}|${Math.round(forceN / 8)}|${gear}`;
    if (key === lastGaugeKey) return;
    lastGaugeKey = key;
    const w = gaugeCanvas.width;
    const h = gaugeCanvas.height;
    gctx.fillStyle = '#060a08';
    gctx.fillRect(0, 0, w, h);
    gctx.strokeStyle = '#1d3a2c';
    gctx.strokeRect(6, 6, w - 12, h - 12);
    // 速度
    gctx.fillStyle = '#7fd8a8';
    gctx.font = 'bold 92px "Segoe UI", sans-serif';
    gctx.textAlign = 'left';
    gctx.fillText(`${Math.round(speedKmh)}`, 34, 128);
    gctx.font = '26px "Segoe UI", sans-serif';
    gctx.fillStyle = '#4a7a62';
    gctx.fillText('km/h', 40, 164);
    // 踏板力条
    const ratio = Math.min(1, forceN / 1612);
    gctx.fillStyle = '#16241d';
    gctx.fillRect(230, 52, 240, 30);
    gctx.fillStyle = ratio > 0.85 ? '#ff4a3c' : ratio > 0.6 ? '#ffb067' : '#7fd8a8';
    gctx.fillRect(230, 52, 240 * ratio, 30);
    gctx.fillStyle = '#9fb6c8';
    gctx.font = '24px "Segoe UI", sans-serif';
    gctx.fillText(`踏板力 ${Math.round(forceN)} N`, 230, 118);
    gctx.fillText(`G ${g.toFixed(2)}`, 230, 152);
    // 挡位
    gctx.fillStyle = '#e8e0d0';
    gctx.font = 'bold 64px "Segoe UI", sans-serif';
    gctx.textAlign = 'right';
    gctx.fillText(gear, w - 34, 220);
    // READY
    gctx.fillStyle = '#7fd8a8';
    gctx.font = '28px "Segoe UI", sans-serif';
    gctx.textAlign = 'center';
    gctx.fillText('READY', w / 2, 240);
    gaugeTex.needsUpdate = true;
  };

  let tmpQuat = new THREE.Quaternion();

  const api: CarLike = {
    root,
    body,
    wheels,
    get currentHeat() {
      return heat;
    },
    spinWheels(dist: number, _dt: number): void {
      const d = (dist / 0.382) * MS_TO_RPM_SCALE;
      for (const w of wheels) w.spin.rotation.x -= d;
    },
    setBrakeLights(intensity: number): void {
      brakeTarget = intensity;
    },
    flashBrakeSnap(): void {
      snapT = 1;
    },
    setHeadlights(on: boolean): void {
      headTarget = on ? HEAD_BASE : 0.15;
    },
    setBrakeHeat(t: number): void {
      heat = t;
    },
    updateCluster(speedKmh: number, forceN: number, g: number, gear: string): void {
      drawGauge(speedKmh, forceN, g, gear);
    },
    setSteer(_angle: number): void {
      /* 直线赛道无转向输入 */
    },
    update(camera: THREE.Camera): void {
      // 刹车灯平滑 + snap 闪红
      brakeLevel += (brakeTarget - brakeLevel) * Math.min(1, 0.28);
      const snapGain = snapT > 0 ? snapT * 10 : 0;
      snapT = Math.max(0, snapT - 0.026);
      if (tailMat) tailMat.emissiveIntensity = brakeLevel + snapGain;
      if (highMat) highMat.emissiveIntensity = brakeLevel * 0.8 + snapGain;
      // 头灯平滑
      headLevel += (headTarget - headLevel) * Math.min(1, 0.2);
      if (headMat) headMat.emissiveIntensity = headLevel;
      if (markMat) markMat.emissiveIntensity = 2.2 + Math.sin(performance.now() * 0.0016) * 0.35;
      // 悬浮轮标朝向相机
      if (camera) {
        camera.getWorldQuaternion(tmpQuat);
        for (const c of caps) c.quaternion.copy(tmpQuat);
      }
    },
    dispose(): void {
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat.dispose();
        }
      });
      gaugeTex.dispose();
    },
  };
  return api;
}
