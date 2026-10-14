/**
 * 路面与路侧：宽 14m 双车道（车道 3.6m）、Canvas 沥青贴图 + 车道线、
 * 2600m 处路障、护栏 + 反光柱、路灯、施工/封闭标牌、终点警示灯。
 * 移植自原版 hg/gg/_g/vg/yg/bg/xg，语义一致。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { TRACK } from '../../config/physics';
import { canvasTexture, makeCanvas, paintNoise, textTexture } from '../../util/canvasTex';

/** 沥青 + 车道线贴图（移植原版 zh，1024×880） */
function roadTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 1024;
  const [canvas, ctx] = makeCanvas(size, 880);
  ctx.fillStyle = '#2a2a2d';
  ctx.fillRect(0, 0, size, 880);
  paintNoise(ctx, size, 880, 60000, 0.22);
  const lanePx = size / 14;
  const px = (m: number): number => size / 2 + m * lanePx;
  ctx.fillStyle = 'rgba(30,30,32,0.55)';
  for (const m of [-3.6, 0, 3.6]) {
    ctx.fillRect(px(m - 0.9), 0, 0.5 * lanePx, 880);
    ctx.fillRect(px(m + 0.4), 0, 0.5 * lanePx, 880);
  }
  const lineW = 0.16 * lanePx;
  ctx.fillStyle = '#e9e6dc';
  ctx.fillRect(px(-5.4) - lineW / 2, 0, lineW, 880);
  ctx.fillRect(px(5.4) - lineW / 2, 0, lineW, 880);
  ctx.fillStyle = '#f2c94c';
  ctx.fillRect(px(-6.6) - lineW / 2, 0, lineW, 880);
  ctx.fillRect(px(6.6) - lineW / 2, 0, lineW, 880);
  ctx.fillStyle = '#e9e6dc';
  for (const m of [-1.8, 1.8]) ctx.fillRect(px(m) - lineW / 2, 0, lineW, 440);
  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

/** 施工警示斜纹贴图 */
function stripeTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 64);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#e8501b';
  for (let x = -64; x < 320; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 64);
    ctx.lineTo(x + 32, 64);
    ctx.lineTo(x + 64, 0);
    ctx.lineTo(x + 32, 0);
    ctx.closePath();
    ctx.fill();
  }
  return canvasTexture(canvas);
}

export class Road {
  /** 路障块（撞车时交给 World 转动态刚体） */
  readonly barrierBlocks: THREE.Mesh[] = [];
  /** 终点警示灯材质（原版呼吸闪烁） */
  private warningLights: THREE.MeshStandardMaterial[] = [];

  constructor(scene: THREE.Scene, anisotropy: number) {
    const roadStart = 260; // 原版 lg
    const roadEnd = -(TRACK.barrierDistance + 700); // 原版 ug
    const roadLength = roadStart - roadEnd;
    const roadCenter = (roadStart + roadEnd) / 2;

    // 大地
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 6000),
      new THREE.MeshStandardMaterial({ color: 0x8a7c72, roughness: 0.62, metalness: 0.05 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, roadCenter);
    ground.receiveShadow = true;
    scene.add(ground);

    // 主路面
    const tex = roadTexture(anisotropy);
    tex.repeat.set(1, roadLength / 12);
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(TRACK.roadWidth, roadLength),
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.38,
        metalness: 0.08,
        envMapIntensity: 0.9
      })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, roadCenter);
    road.receiveShadow = true;
    scene.add(road);

    this.buildCurbs(scene, roadCenter, roadLength);
    this.buildGuardrails(scene, roadCenter, roadLength);
    this.buildStreetLamps(scene, roadStart);
    this.buildSigns(scene);
    this.buildBarriers(scene);
    this.buildWarningLights(scene);
  }

  private buildCurbs(scene: THREE.Scene, center: number, length: number): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0x9a949a, roughness: 0.8 });
    for (const side of [-1, 1]) {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, length), mat);
      curb.position.set(side * (TRACK.roadWidth / 2 + 0.2), 0.07, center);
      curb.receiveShadow = true;
      scene.add(curb);
    }
  }

  private buildGuardrails(scene: THREE.Scene, center: number, length: number): void {
    const railMat = new THREE.MeshStandardMaterial({ color: 0xb8bcbe, metalness: 0.6, roughness: 0.55 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8b8d90, metalness: 0.7, roughness: 0.45 });
    const sideX = TRACK.roadWidth / 2 + 1.1;
    const posts = Math.floor(length / 4);
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.8, 0.12), postMat, posts * 2);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, length), railMat);
      rail.position.set(side * sideX, 0.66, center);
      rail.castShadow = true;
      scene.add(rail);
      for (let p = 0; p < posts; p++) {
        m.makeTranslation(side * (sideX + 0.1), 0.4, 260 - p * 4);
        instanced.setMatrixAt(i++, m);
      }
    }
    instanced.castShadow = true;
    scene.add(instanced);
  }

  private buildStreetLamps(scene: THREE.Scene, roadStart: number): void {
    const count = Math.floor((TRACK.barrierDistance + 700) / 45);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4244, metalness: 0.8, roughness: 0.4 });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x222222,
      emissive: 0xff8f2a,
      emissiveIntensity: 3.2
    });
    const sideX = TRACK.roadWidth / 2 + 2.2;
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.14, 9, 8), poleMat, count * 2);
    const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.1, 0.1), poleMat, count * 2);
    const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.12, 0.35), lampMat, count * 2);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const side of [-1, 1]) {
      for (let n = 0; n < count; n++) {
        const z = roadStart - n * 45 - (side > 0 ? 45 / 2 : 0);
        m.makeTranslation(side * sideX, 4.5, z);
        poles.setMatrixAt(i, m);
        m.makeTranslation(side * (sideX - 1.15), 8.95, z);
        arms.setMatrixAt(i, m);
        m.makeTranslation(side * (sideX - 2.1), 8.85, z);
        lamps.setMatrixAt(i, m);
        i++;
      }
    }
    poles.castShadow = true;
    scene.add(poles, arms, lamps);
  }

  private buildSigns(scene: THREE.Scene): void {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x7c7c7c, metalness: 0.8, roughness: 0.4 });
    const makeSign = (z: number, lines: string[], bg: string, fg: string, side: number): void => {
      const tex = textTexture(lines, bg, fg);
      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(4, 2),
        new THREE.MeshStandardMaterial({
          map: tex,
          roughness: 0.5,
          emissive: 0xffffff,
          emissiveMap: tex,
          emissiveIntensity: 0.25
        })
      );
      board.position.set(side * (TRACK.roadWidth / 2 + 3.2), 4.2, z);
      scene.add(board);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.2, 8), poleMat);
      pole.position.set(side * (TRACK.roadWidth / 2 + 3.2), 2.1, z - 0.05);
      pole.castShadow = true;
      scene.add(pole);
    };
    const barrierZ = -TRACK.barrierDistance;
    for (const d of [1500, 1000, 500]) makeSign(barrierZ + d, ['前方施工', `${d} m`], '#0f6b3a', '#ffffff', 1);
    for (const d of [300, 200, 100]) makeSign(barrierZ + d, ['道路封闭', `${d} m`], '#f2b21b', '#1a1a1a', 1);
    makeSign(-80, ['极限刹车挑战', '100 km/h 后可刹车'], '#14325c', '#ffffff', -1);
  }

  private buildBarriers(scene: THREE.Scene): void {
    const z = -TRACK.barrierDistance;
    const stripeMat = new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.5 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.9 });
    for (let x = -6; x <= 6; x += 2) {
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 1, 0.7),
        [concrete, concrete, concrete, concrete, stripeMat, stripeMat]
      );
      block.position.set(x, 0.5, z);
      block.castShadow = true;
      block.receiveShadow = true;
      scene.add(block);
      this.barrierBlocks.push(block);
    }
    const bannerTex = textTexture(['道路封闭  ROAD CLOSED'], '#d8351b', '#ffffff', 1024, 256);
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 2.2),
      new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.5 })
    );
    banner.position.set(0, 3.4, z - 3);
    scene.add(banner);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x555540, metalness: 0.7, roughness: 0.4 });
    for (const x of [-4.2, 4.2]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4.5, 8), poleMat);
      pole.position.set(x, 2.25, z - 3.05);
      scene.add(pole);
    }
  }

  private buildWarningLights(scene: THREE.Scene): void {
    // P4 性能：4 个灯球合批为 1 个网格 + 共享 1 材质（update 本就统一改同一强度值，省 3 DC + 3 材质）
    const mat = new THREE.MeshStandardMaterial({
      color: 0x663300,
      emissive: 0xff5a0a,
      emissiveIntensity: 4
    });
    const geos: THREE.BufferGeometry[] = [];
    for (let x = -6; x <= 6; x += 4) {
      const geo = new THREE.SphereGeometry(0.16, 16, 12);
      geo.translate(x, 1.18, -TRACK.barrierDistance);
      geos.push(geo);
    }
    scene.add(new THREE.Mesh(mergeSafe(geos), mat));
    this.warningLights.push(mat);
  }

  /** 路灯常亮 + 终点警示灯呼吸闪烁（原版 update 语义） */
  update(time: number): void {
    const intensity = Math.sin(time * 9) > 0 ? 6 : 0.2;
    for (const mat of this.warningLights) mat.emissiveIntensity = intensity;
  }
}
