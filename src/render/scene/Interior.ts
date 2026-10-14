/**
 * 内饰程序化装配（驾驶员视角 P3 会用，本阶段建齐几何）。
 * 依据公开报道资料的中文命名注释：
 * - 三联屏：12.3 英寸仪表屏 + 17.2 英寸中控/副驾双联屏（21:10）
 * - 三辐方向盘（木纹外圈 + 中央发光车标，随前轮转向微转）
 * - 星环散射体：仪表台上方弧形发光灯带（暖白→青色渐变散射）
 * - L 型中岛 + 水晶旋钮 + 巴黎钉纹面板
 * - 四座布局示意 + 车门内饰板 + 氛围灯带
 *
 * P3 调光（材质与光照设计师·调光）——「墨阑棕」配色：
 * - 深棕真皮（Canvas 全粒面质感 + 米/棕双色缝线示意）
 * - 胡桃木饰板（Canvas 木纹颜色贴图 → SRGB）
 * - 水晶旋钮（MeshPhysicalMaterial transmission，metalness 0）
 * - 巴黎钉纹凹凸贴图：数据贴图，colorSpace 强制 NoColorSpace（禁止 sRGB）
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeSafe } from '../../util/geo';
import { PALETTE } from '../../config/theme';
import { canvasTexture, makeCanvas, paintNoise } from '../../util/canvasTex';

/** 鸿蒙风静态中控 UI 贴图（颜色贴图 → SRGB） */
function harmonyUiTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(512, 244);
  const bg = '#0b1420';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 244);
  paintNoise(ctx, 512, 244, 800, 0.05);
  // 卡片式磁贴
  const tiles: Array<[number, number, number, number, string, string]> = [
    [16, 16, 150, 100, '#14325c', '导航'],
    [182, 16, 150, 100, '#0f6b3a', '音乐'],
    [348, 16, 148, 100, '#5a3a14', '空调'],
    [16, 132, 316, 96, '#1a1f2c', '智慧场景'],
    [348, 132, 148, 96, '#3a1430', '座椅']
  ];
  for (const [x, y, w, h, color, label] of tiles) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 12);
    ctx.fill();
    ctx.fillStyle = '#e8eef6';
    ctx.font = '18px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + w / 2, y + h / 2 + 6);
  }
  return canvasTexture(canvas);
}

/**
 * 巴黎钉纹凹凸贴图 —— 数据贴图！
 * 灰度凹凸信息，必须使用 NoColorSpace（Linear 语义），
 * 设成 sRGB 会让凹凸强度非线性失真。
 */
function parisNailTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 128);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 128, 128);
  for (let y = 8; y < 128; y += 16) {
    for (let x = 8; x < 128; x += 16) {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, 6);
      grad.addColorStop(0, '#404040');
      grad.addColorStop(1, '#a0a0a0');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = canvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // 数据贴图：覆盖 canvasTexture 默认的 sRGB
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 深棕真皮全粒面质感 + 米/棕双色缝线示意（颜色贴图 → SRGB） */
function leatherTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 256);
  ctx.fillStyle = '#4a3324';
  ctx.fillRect(0, 0, 256, 256);
  paintNoise(ctx, 256, 256, 2600, 0.16);
  // 全粒面细碎纹理：短弧线
  for (let i = 0; i < 420; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    ctx.strokeStyle = `rgba(${30 + Math.random() * 40},${18 + Math.random() * 28},${10 + Math.random() * 18},0.25)`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(x, y, 1.5 + Math.random() * 3, Math.random() * Math.PI, Math.PI + Math.random() * Math.PI);
    ctx.stroke();
  }
  // 米色 + 棕色双色缝线（虚线）
  const stitch = (y: number, color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  stitch(40, '#d8cbb4'); // 米色缝线
  stitch(216, '#2a1a10'); // 深棕缝线
  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 胡桃木木纹贴图（颜色贴图 → SRGB） */
function walnutTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 256);
  ctx.fillStyle = '#6e4a2c';
  ctx.fillRect(0, 0, 256, 256);
  // 纵向木纹：正弦扰动的深浅条纹
  for (let x = 0; x < 256; x += 2) {
    const wobble =
      Math.sin(x * 0.055) * 6 + Math.sin(x * 0.021 + 1.7) * 10 + Math.sin(x * 0.13) * 2.5;
    const shade = 0.55 + 0.45 * Math.abs(Math.sin(x * 0.08 + wobble * 0.05));
    const r = Math.round(0x6e * shade + 18);
    const g = Math.round(0x4a * shade + 10);
    const b = Math.round(0x2c * shade + 6);
    ctx.fillStyle = `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
    ctx.fillRect(x, 0, 2, 256);
  }
  paintNoise(ctx, 256, 256, 900, 0.06);
  // 一条深色木纹带
  ctx.fillStyle = 'rgba(48,28,14,0.5)';
  for (let y = 0; y < 256; y++) {
    const x = 150 + Math.sin(y * 0.04) * 8 + Math.sin(y * 0.11) * 3;
    ctx.fillRect(x, y, 7, 1);
  }
  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 星环散射体渐变贴图：暖白 → 青色（颜色贴图 → SRGB） */
function starRingTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 8);
  const grad = ctx.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, '#ffd9a0'); // 暖白端（驾驶员侧）
  grad.addColorStop(0.5, '#ffe9c8');
  grad.addColorStop(1, '#7fd8e8'); // 青色端（副驾侧）
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 8);
  return canvasTexture(canvas);
}

export class Interior {
  readonly group = new THREE.Group();
  private clusterCtx: CanvasRenderingContext2D;
  private clusterTexture: THREE.CanvasTexture;
  private steeringWheel: THREE.Group;
  /** 仪表屏重绘节流：内容 key + 上次重绘时刻（P4 性能：避免每帧 canvas 光栅化 + GPU 上传） */
  private clusterKey = '';
  private clusterLastDraw = -Infinity;

  constructor() {
    // ---- 「墨阑棕」内饰材质组 ----
    // 软触深色（仪表台/门板基底）：哑光低反射
    const dark = new THREE.MeshStandardMaterial({
      color: PALETTE.interiorDark,
      roughness: 0.82,
      metalness: 0.0
    });
    // 深棕真皮：全粒面 Canvas 贴图（颜色 → SRGB），roughness 0.6
    const leather = new THREE.MeshStandardMaterial({
      color: 0xffffff, // 色相由贴图承载
      map: leatherTexture(),
      roughness: 0.6,
      metalness: 0.0
    });
    // 胡桃木饰板：木纹颜色贴图（SRGB）+ 清漆层
    const wood = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: walnutTexture(),
      roughness: 0.4,
      metalness: 0.0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25
    });

    // ---- 仪表台（软触深色 + 木纹上沿压条）----
    const dash = new THREE.Mesh(new RoundedBoxGeometry(1.8, 0.3, 0.5, 2, 0.08), dark);
    dash.position.set(0, 1.18, -1.35);
    this.group.add(dash);
    const dashTrim = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.03, 0.08), wood);
    dashTrim.position.set(0, 1.345, -1.28);
    this.group.add(dashTrim);

    // ---- 三联屏（12.3 仪表 + 17.2×2 中控/副驾，21:10）----
    const clusterCanvas = document.createElement('canvas');
    clusterCanvas.width = 512;
    clusterCanvas.height = 244;
    const cctx = clusterCanvas.getContext('2d');
    if (!cctx) throw new Error('2D canvas unavailable');
    this.clusterCtx = cctx;
    this.clusterTexture = canvasTexture(clusterCanvas);
    const cluster = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.2),
      new THREE.MeshBasicMaterial({ map: this.clusterTexture })
    );
    cluster.position.set(-0.55, 1.36, -1.32);
    cluster.rotation.x = -0.12;
    cluster.rotation.y = 0.18;
    this.group.add(cluster);

    const uiTex = harmonyUiTexture();
    const center = new THREE.Mesh(
      new THREE.PlaneGeometry(0.72, 0.34),
      new THREE.MeshBasicMaterial({ map: uiTex })
    );
    center.position.set(0.08, 1.34, -1.28);
    center.rotation.x = -0.12;
    this.group.add(center);
    const passenger = center.clone();
    passenger.position.set(0.82, 1.34, -1.28);
    this.group.add(passenger);

    // ---- 三辐方向盘（外圈真皮环 + 木纹辐板 + 中央发光车标）----
    this.steeringWheel = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.02, 10, 32), leather);
    this.steeringWheel.add(rim);
    const spokeMat = wood;
    for (const angle of [0, 2.4, -2.4]) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.02), spokeMat);
      spoke.position.set(Math.sin(angle) * 0.08, -Math.cos(angle) * 0.08, 0);
      spoke.rotation.z = -angle;
      this.steeringWheel.add(spoke);
    }
    const emblem = new THREE.Mesh(
      new THREE.CircleGeometry(0.035, 20),
      new THREE.MeshStandardMaterial({
        color: 0x201808,
        emissive: 0xffd980,
        emissiveIntensity: 1.4
      })
    );
    emblem.position.z = 0.012;
    this.steeringWheel.add(emblem);
    this.steeringWheel.position.set(-0.55, 1.22, -1.1);
    this.steeringWheel.rotation.x = 0.32;
    this.group.add(this.steeringWheel);

    // ---- 星环散射体（仪表台上方弧形发光灯带，暖白→青渐变）----
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.008, 8, 40, Math.PI),
      new THREE.MeshStandardMaterial({
        color: 0x1a120c,
        emissive: 0xffffff,
        emissiveMap: starRingTexture(),
        emissiveIntensity: 2.8
      })
    );
    ring.position.set(0, 1.62, -1.2);
    ring.rotation.set(0.25, 0, 0);
    this.group.add(ring);

    // ---- L 型中岛（巴黎钉纹凹凸：数据贴图 NoColorSpace）----
    const islandMat = new THREE.MeshStandardMaterial({
      color: 0x241a12,
      roughness: 0.45,
      metalness: 0.05,
      bumpMap: parisNailTexture(),
      bumpScale: 0.8
    });
    const islandLong = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.3, 1.1, 2, 0.04), islandMat);
    islandLong.position.set(0, 0.95, 0.35);
    this.group.add(islandLong);
    const islandCross = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.3, 0.22, 2, 0.04), islandMat);
    islandCross.position.set(-0.14, 0.95, -0.18);
    this.group.add(islandCross);

    // ---- 水晶旋钮：metalness 0 / roughness 0.05 / transmission 高透 ----
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 20, 16),
      new THREE.MeshPhysicalMaterial({
        color: PALETTE.crystal,
        metalness: 0.0,
        roughness: 0.05,
        transmission: 0.9,
        thickness: 0.08,
        ior: 1.45,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        envMapIntensity: 1.2
      })
    );
    knob.position.set(-0.14, 1.14, -0.18);
    this.group.add(knob);

    // ---- 四座布局示意（深棕真皮座椅）----
    // P4 性能：8 个独立网格合批为 1 个（同材质，几何变换后 merge，视觉不变，省 7 DC）
    const seatGeos: THREE.BufferGeometry[] = [];
    const seatPositions: Array<[number, number]> = [
      [-0.55, -0.5],
      [0.55, -0.5],
      [-0.55, 1.1],
      [0.55, 1.1]
    ];
    for (const [x, z] of seatPositions) {
      const baseGeo = new RoundedBoxGeometry(0.56, 0.16, 0.56, 2, 0.05);
      baseGeo.translate(x, 0.72, z);
      const backGeo = new RoundedBoxGeometry(0.56, 0.62, 0.14, 2, 0.05);
      backGeo.rotateX(0.14);
      backGeo.translate(x, 1.05, z + 0.26);
      seatGeos.push(baseGeo, backGeo);
    }
    this.group.add(new THREE.Mesh(mergeSafe(seatGeos), leather));

    // ---- 车门内饰板 + 氛围灯带（暖琥珀，与星环暖端呼应）----
    // P4 性能：左右门板合批 1 网格、左右灯带合批 1 网格 + 共享 1 材质（省 2 DC + 1 材质）
    const panelGeos: THREE.BufferGeometry[] = [];
    const stripGeos: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const panelGeo = new RoundedBoxGeometry(0.05, 0.5, 2.6, 2, 0.02);
      panelGeo.translate(side * 0.92, 1.05, 0.4);
      panelGeos.push(panelGeo);
      const stripGeo = new THREE.BoxGeometry(0.012, 0.012, 2.2);
      stripGeo.translate(side * 0.89, 1.22, 0.4);
      stripGeos.push(stripGeo);
    }
    this.group.add(new THREE.Mesh(mergeSafe(panelGeos), dark));
    this.group.add(
      new THREE.Mesh(
        mergeSafe(stripGeos),
        new THREE.MeshStandardMaterial({
          color: 0x100a06,
          emissive: 0xffa860,
          emissiveIntensity: 1.8
        })
      )
    );
  }

  /**
   * 仪表屏更新：速度 / 踏板力 / G 值。
   * P4 性能约束：canvas 全量重绘 + 纹理上传是大头，限频 15Hz 且内容无变化时跳过
   * （数字读数 15Hz 刷新肉眼无差别，静止时零重绘）。
   */
  updateCluster(speedKmh: number, pedalForceN: number, gForce: number, gear: string): void {
    const key = `${Math.round(speedKmh)}|${Math.round(pedalForceN)}|${gForce.toFixed(2)}|${gear}`;
    if (key === this.clusterKey) return;
    const now = performance.now();
    if (now - this.clusterLastDraw < 66) return;
    this.clusterLastDraw = now;
    this.clusterKey = key;
    const ctx = this.clusterCtx;
    ctx.fillStyle = '#0b1420';
    ctx.fillRect(0, 0, 512, 244);
    ctx.fillStyle = '#f1dcae';
    ctx.textAlign = 'center';
    ctx.font = 'bold 92px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`${Math.round(speedKmh)}`, 150, 128);
    ctx.font = '20px "PingFang SC", sans-serif';
    ctx.fillText('km/h', 150, 158);
    ctx.fillStyle = '#30c8ff';
    ctx.font = 'bold 46px sans-serif';
    ctx.fillText(gear, 380, 90);
    ctx.fillStyle = '#ff6a3d';
    ctx.font = '22px "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`踏板力 ${Math.round(pedalForceN)} N`, 290, 140);
    ctx.fillStyle = '#5fe0a0';
    ctx.fillText(`G ${gForce.toFixed(2)}`, 290, 176);
    this.clusterTexture.needsUpdate = true;
  }

  /** 方向盘随前轮转向微转（视觉反馈） */
  setSteer(angle: number): void {
    this.steeringWheel.rotation.z = angle * 3;
  }
}
