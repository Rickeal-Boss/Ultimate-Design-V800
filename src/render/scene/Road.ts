/**
 * 路面与路侧：宽 14m 双车道（车道 3.6m）、Canvas 沥青贴图 + 车道线、
 * 2600m 处路障、护栏 + 反光柱、路灯、施工/封闭标牌、终点警示灯。
 * 移植自原版 hg/gg/_g/vg/yg/bg/xg，语义一致。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { TRACK } from '../../config/physics';
import { canvasTexture, makeCanvas, paintNoise, textTexture } from '../../util/canvasTex';
import { makeLcg } from '../../util/math';

/**
 * 河谷几何契约（R14）：Road 与 Waterway 共用同一组开槽数值。
 *
 * 旧版水只是「路面两侧 1cm 高的反光地面」，桥是横跨公路的高架，二者无水体关系。
 * R14 把 z≈−450 改造成真正的河谷：Road 的大地面在此开一个矩形槽（x ±150 /
 * z ±80），Waterway 在槽内做「河床 + 四周护坡 + 水面 + 跨河桥面」。
 * 槽口边缘与护坡外缘严格同点同高（y=−0.02），避免看到地面断口。
 *
 * R18：水面由 −4.4 抬到 −0.14（桥面下 0.11m）、河床由 −5.6 收到 −1.45。
 * 水面与岸坡的交线因此贴近槽口（±147.5 / ±77.5），水线之外只剩 2.5m 干坡，
 * 不会再出现「一大片棕色坡面把水挡住」的画面。
 */
export const RIVER = {
  /** 河谷/桥梁中心 z */
  centerZ: -450,
  /** 地面开槽半宽（x 方向）——总宽 300m，可见水面约 253m */
  holeHalfX: 150,
  /** 地面开槽半长（z 方向）——总长 160m，可见水面约 113m */
  holeHalfZ: 80,
  /**
   * 河床/槽底 y（R18：水面抬到桥面附近后只需保留 1.31m 水深）。
   * 原 −5.6 是「深谷」配置：护坡从槽口 −0.02 跌 5.58m，30m 外的坡面在
   * 掠射角下糊成一整块棕色挡墙，把 −4.4 的水面完全遮住 → 用户读成沙地。
   */
  bedY: -1.45,
  /**
   * 水面 y（R18：桥面顶 −0.03 下方 0.11m，几乎与桥面平齐）。
   * 原 −4.4 比桥面低 4.37m，从车里只能看到护坡土色。
   */
  waterY: -0.14,
  /** 平底河床半宽（x） */
  bedHalfX: 120,
  /** 平底河床半长（z） */
  bedHalfZ: 50,
  /** 桥面板半宽（x） */
  deckHalfX: 7.4,
  /** 桥面板半长（z）：与开槽等长，桥端正好落在岸上 */
  deckHalfZ: 80,
  /** 桥面板顶面 y（压在路面 y=0 之下，避免与路面争深度） */
  deckTopY: -0.03,
  /** 桥面板厚 */
  deckThickness: 0.35,
  /** 桥侧矮墙高（可被翻滚车体翻越，不是无限护栏） */
  parapetHeight: 0.55
} as const;

/** 地表细节贴图（土/砾石噪点，近白灰度 → 只提供细节，色相由 material.color 决定） */
export function createSoilTexture(): THREE.CanvasTexture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);
  ctx.fillStyle = '#f2eee8';
  ctx.fillRect(0, 0, size, size);
  const random = makeLcg(918273);
  for (let i = 0; i < 2600; i++) {
    const g = Math.floor(140 + random() * 110);
    ctx.fillStyle = `rgba(${g},${g - 4},${g - 10},${(0.08 + random() * 0.22).toFixed(3)})`;
    const r = 0.6 + random() * 2.6;
    ctx.beginPath();
    ctx.ellipse(random() * size, random() * size, r, r * (0.5 + random() * 0.8), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 稀疏深色裂缝/干纹，提供 6m 尺度的可读纹理
  for (let i = 0; i < 26; i++) {
    ctx.strokeStyle = `rgba(96,86,76,${(0.10 + random() * 0.14).toFixed(3)})`;
    ctx.lineWidth = 0.6 + random() * 0.9;
    ctx.beginPath();
    const x = random() * size;
    const y = random() * size;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (random() - 0.5) * 40, y + (random() - 0.5) * 40);
    ctx.stroke();
  }
  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

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

    // 大地（R14：绕河谷开槽，4 块拼合并为 1 DC）
    this.buildGround(scene, roadCenter);

    // 主路面
    const tex = roadTexture(anisotropy);
    tex.repeat.set(1, roadLength / 12);
    // R18：黄昏环境反射在低机位掠射角下把整幅沥青洗成浅棕「沙地」
    // （envMapIntensity 0.9 + roughness 0.38 的菲涅耳镜像）。A/B 实证
    // verify/r18c_base vs verify/r18c（同机位 #eye=-4.8,1.35,7.5,0,0.55,0）：
    // 前景路面 (80,47,35)→(62,39,33)，棕色收敛、标线回清，故定稿 0.45/0.50。
    // 只动主路面材质；路肩/护栏/标线（贴图内）不动。
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(TRACK.roadWidth, roadLength),
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.5,
        metalness: 0.08,
        envMapIntensity: 0.45
      })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, roadCenter);
    road.receiveShadow = true;
    road.name = 'road';
    scene.add(road);

    this.buildCurbs(scene, roadCenter, roadLength);
    this.buildGuardrails(scene);
    this.buildStreetLamps(scene, roadStart);
    this.buildSigns(scene);
    this.buildBarriers(scene);
    this.buildWarningLights(scene);
  }

  /**
   * 大地：在原 3000×6000 平面上挖出河谷槽口（x ±150 / z −530..−370），
   * 拆成「远岸(北) / 近岸(南) / 西岸条 / 东岸条」四块后用 mergeSafe 合为 1 mesh。
   * 四块与槽内护坡在槽口边缘同点同位（y=−0.02），接缝埋在护坡棱线上。
   */
  private buildGround(scene: THREE.Scene, center: number): void {
    const holeNear = RIVER.centerZ + RIVER.holeHalfZ; // -370（车行上游侧）
    const holeFar = RIVER.centerZ - RIVER.holeHalfZ; // -530
    const southEdge = center - 3000; // -3870
    const northEdge = center + 3000; // 2130

    const pieces: THREE.BufferGeometry[] = [];
    /** 每 6m 一个贴图周期；UV 按世界尺寸缩放，四块拼合后纹理密度一致 */
    const TILE = 6;
    const slab = (w: number, d: number, x: number, z: number): THREE.BufferGeometry => {
      const g = new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      g.translate(x, -0.02, z);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, (uv.getX(i) * w) / TILE, (uv.getY(i) * d) / TILE);
      }
      uv.needsUpdate = true;
      return g;
    };
    // 北块（车行上游侧整幅）
    pieces.push(slab(3000, northEdge - holeNear, 0, (northEdge + holeNear) / 2));
    // 南块（路障一侧整幅）
    pieces.push(slab(3000, holeFar - southEdge, 0, (southEdge + holeFar) / 2));
    // 西 / 东两块（槽口 ±150 之外）
    const sideW = 1500 - RIVER.holeHalfX;
    for (const side of [-1, 1]) {
      pieces.push(
        slab(
          sideW,
          RIVER.holeHalfZ * 2,
          side * (RIVER.holeHalfX + sideW / 2),
          RIVER.centerZ
        )
      );
    }
    const ground = new THREE.Mesh(
      mergeSafe(pieces),
      new THREE.MeshStandardMaterial({
        color: 0x8a7c72,
        map: createSoilTexture(),
        roughness: 0.62,
        metalness: 0.05
      })
    );
    ground.name = 'ground';
    ground.receiveShadow = true;
    scene.add(ground);
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

  /**
   * 护栏（R14 分段）：x=±8.1 的波形梁在河谷段必须断开 —— 桥面只到 ±7.4，
   * 跨河继续铺护栏会悬在河面上。断口正好落在桥台（z=−370 / −530），
   * 桥段改由 Waterway 的 0.55m 桥侧矮墙接管。
   */
  private buildGuardrails(scene: THREE.Scene): void {
    const railMat = new THREE.MeshStandardMaterial({ color: 0xb8bcbe, metalness: 0.6, roughness: 0.55 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8b8d90, metalness: 0.7, roughness: 0.45 });
    const sideX = TRACK.roadWidth / 2 + 1.1;
    const gapNear = RIVER.centerZ + RIVER.holeHalfZ; // -370
    const gapFar = RIVER.centerZ - RIVER.holeHalfZ; // -530
    const startZ = 260;
    const endZ = -(TRACK.barrierDistance + 700); // -2000
    const segments: readonly (readonly [number, number])[] = [
      [startZ, gapNear],
      [gapFar, endZ]
    ];

    // 立柱 z 序列：4m 一根，跳过河谷段（断口两侧各留 1 根）
    const postZ: number[] = [];
    for (let z = startZ; z >= endZ; z -= 4) {
      if (z < gapNear && z > gapFar) continue;
      postZ.push(z);
    }
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.8, 0.12), postMat, postZ.length * 2);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const side of [-1, 1]) {
      for (const [from, to] of segments) {
        const len = from - to;
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, len), railMat);
        rail.position.set(side * sideX, 0.66, (from + to) / 2);
        rail.castShadow = true;
        scene.add(rail);
      }
      for (const z of postZ) {
        m.makeTranslation(side * (sideX + 0.1), 0.4, z);
        instanced.setMatrixAt(i++, m);
      }
    }
    instanced.count = i;
    instanced.castShadow = true;
    scene.add(instanced);
  }

  private buildStreetLamps(scene: THREE.Scene, roadStart: number): void {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4244, metalness: 0.8, roughness: 0.4 });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x222222,
      emissive: 0xff8f2a,
      emissiveIntensity: 3.2
    });
    const sideX = TRACK.roadWidth / 2 + 2.2;
    const gapNear = RIVER.centerZ + RIVER.holeHalfZ; // -370
    const gapFar = RIVER.centerZ - RIVER.holeHalfZ; // -530
    const total = Math.floor((TRACK.barrierDistance + 700) / 45);
    // 先收集落点（灯杆 x=±9.2 在桥面 ±7.4 之外，河谷段必须整根不立）
    const spots: { side: number; z: number }[] = [];
    for (const side of [-1, 1]) {
      for (let n = 0; n < total; n++) {
        const z = roadStart - n * 45 - (side > 0 ? 45 / 2 : 0);
        if (z < gapNear + 5 && z > gapFar - 5) continue;
        spots.push({ side, z });
      }
    }
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.14, 9, 8), poleMat, spots.length);
    const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.1, 0.1), poleMat, spots.length);
    const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.12, 0.35), lampMat, spots.length);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const s of spots) {
      m.makeTranslation(s.side * sideX, 4.5, s.z);
      poles.setMatrixAt(i, m);
      m.makeTranslation(s.side * (sideX - 1.15), 8.95, s.z);
      arms.setMatrixAt(i, m);
      m.makeTranslation(s.side * (sideX - 2.1), 8.85, s.z);
      lamps.setMatrixAt(i, m);
      i++;
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
