/**
 * 跨路高架桥 + 桥下水带 + 两岸护坡（r13 场景件，纯视觉、零物理碰撞体）。
 * 布局：桥/水中心 z=−450（路障 z=−1300 上游），车在加速/刹车段从桥下穿过。
 * 性能：全部几何 mergeSafe 合并 —— 桥 3 mesh（桥面组 castShadow / 桥墩组 / 栏杆）
 * + 水 1 mesh 1 材质 + 护坡 1 mesh ≈ 共 5 DC / 约 700 tri。
 * 动画：update(time) 只做贴图 offset 位移（uniform 更新，零每帧 GL 状态切换、零顶点上传）。
 *
 * 水面高度说明：既有 Road.ts 大地平面位于 y=−0.02 且横贯全场，任何低于它的
 * 水面都会被遮挡（本模块禁改 Road.ts），故水面取 y=−0.01（路面 0 之下、
 * 大地之上），并开 polygonOffset 负偏置保证远距离深度精度下稳定压过大地面；
 * 水带在路面足迹之外拆成两条（x∈[±7.4,±13.2]），与路面零重叠避免争抢深度，
 * 视觉上路基以路缘石+护坡跨河（路堤语义），桥下净空 6.0m ≥ 车顶 1.85m 需求。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { createWaterColorTexture, createWaterNormalTexture } from './waterTexture';

/** 桥/水中心 z（位于路障 −1300 与起点 0 之间，刹车段必经） */
const CENTER_Z = -450;
/** 水带沿路方向半长（总长 120m：z −510 → −390） */
const WATER_HALF_LEN = 60;
/** 水面外缘 |x|（水带宽 ≈ 26m，跨路两侧） */
const WATER_EDGE_X = 13.2;
/** 水面 y（略低于路面 0，高于既有大地平面 −0.02） */
const WATER_Y = -0.01;
/** 桥下净空（桥面底缘）：≥ 6m 规格 */
const CLEARANCE = 6;

export class Waterway {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly colorTex: THREE.CanvasTexture;
  private readonly normalTex: THREE.CanvasTexture;

  constructor(scene: THREE.Scene) {
    this.colorTex = createWaterColorTexture();
    this.normalTex = createWaterNormalTexture();
    // 错位平铺：窄长水带每格约 3m×12m，法线图更密制造碎波层次
    this.colorTex.repeat.set(2, 10);
    this.normalTex.repeat.set(3, 14);
    this.textures.push(this.colorTex, this.normalTex);
    this.buildBridge(scene);
    this.buildWater(scene);
    this.buildSlopes(scene);
  }

  /** 高架桥：桥面+缘梁（castShadow）+ 桥墩×2 + 混凝土帽 + 双侧金属栏杆 = 3 mesh */
  private buildBridge(scene: THREE.Scene): void {
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.9 });
    const railing = new THREE.MeshStandardMaterial({
      color: 0x9ea3a6,
      metalness: 0.6,
      roughness: 0.5
    });
    this.materials.push(concrete, railing);

    // 桥面组：主桥面 + 两侧缘梁（横跨 x −24 → +24，宽 7m）
    const deckGeos: THREE.BufferGeometry[] = [];
    const deck = new THREE.BoxGeometry(48, 0.9, 7);
    deck.translate(0, CLEARANCE + 0.45, CENTER_Z);
    deckGeos.push(deck);
    for (const side of [-1, 1]) {
      const fascia = new THREE.BoxGeometry(48, 1.0, 0.45);
      fascia.translate(0, CLEARANCE + 0.5, CENTER_Z + side * 3.28);
      deckGeos.push(fascia);
    }
    const deckMesh = new THREE.Mesh(mergeSafe(deckGeos), concrete);
    deckMesh.castShadow = true; // 阴影贴图跟随车辆（Lighting.update focus），仅桥面投影
    scene.add(deckMesh);
    this.track(scene, deckMesh);

    // 桥墩组：x=±10.5（公路边缘 7m / 护栏 8.1m 之外，行车净通道）+ 顶部帽梁
    const pierGeos: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const pier = new THREE.BoxGeometry(1.8, CLEARANCE + 0.02, 1.6);
      pier.translate(side * 10.5, (CLEARANCE + 0.02) / 2 - 0.01, CENTER_Z);
      pierGeos.push(pier);
      const cap = new THREE.BoxGeometry(2.8, 0.7, 2.4);
      cap.translate(side * 10.5, CLEARANCE - 0.15, CENTER_Z);
      pierGeos.push(cap);
    }
    const pierMesh = new THREE.Mesh(mergeSafe(pierGeos), concrete);
    scene.add(pierMesh);
    this.track(scene, pierMesh);

    // 栏杆组：双侧顶部扶手 + 中横杆 + 立柱（间距 2.4m）
    const railGeos: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const z = CENTER_Z + side * 3.45;
      const top = new THREE.BoxGeometry(48, 0.12, 0.08);
      top.translate(0, CLEARANCE + 1.9, z);
      railGeos.push(top);
      const mid = new THREE.BoxGeometry(48, 0.1, 0.06);
      mid.translate(0, CLEARANCE + 1.4, z);
      railGeos.push(mid);
      for (let x = -24; x <= 24; x += 2.4) {
        const post = new THREE.BoxGeometry(0.08, 1.0, 0.08);
        post.translate(x, CLEARANCE + 1.4, z);
        railGeos.push(post);
      }
    }
    const railMesh = new THREE.Mesh(mergeSafe(railGeos), railing);
    scene.add(railMesh);
    this.track(scene, railMesh);
  }

  /**
   * 水带：路面两侧两条平面合并为 1 mesh 1 材质（贴图 offset 流动，无顶点波动）。
   * polygonOffset 负偏置：远距离深度精度下稳定盖过 y=−0.02 的大地面。
   */
  private buildWater(scene: THREE.Scene): void {
    const material = new THREE.MeshStandardMaterial({
      map: this.colorTex,
      normalMap: this.normalTex,
      roughness: 0.22,
      metalness: 0.5,
      envMapIntensity: 0.85,
      transparent: true,
      opacity: 0.92,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2
    });
    this.materials.push(material);

    const geos: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const strip = new THREE.PlaneGeometry(WATER_EDGE_X - 7.4, WATER_HALF_LEN * 2);
      strip.rotateX(-Math.PI / 2);
      // 条带中心 x = (7.4 + 13.2)/2 = 10.3，内缘抵路缘石外脸（7.4），外缘塞进护坡底
      strip.translate(side * 10.3, WATER_Y, CENTER_Z);
      geos.push(strip);
    }
    const water = new THREE.Mesh(mergeSafe(geos), material);
    scene.add(water);
    this.track(scene, water);
  }

  /** 护坡：两岸斜面长条（土色与 Road 大地同色系 → 视觉并入大地，水面不悬空） */
  private buildSlopes(scene: THREE.Scene): void {
    const soil = new THREE.MeshStandardMaterial({ color: 0x8a7c72, roughness: 0.62, metalness: 0.05 });
    this.materials.push(soil);

    // 坡顶 (|x|=15.0, y=0.30) → 坡底 (|x|=13.05, y=−0.01)：倾角 ≈ 9°
    const angle = Math.atan2(0.31, 1.95);
    const geos: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const slope = new THREE.BoxGeometry(1.98, 0.12, WATER_HALF_LEN * 2);
      slope.rotateZ(side * angle);
      slope.translate(side * 14.03, 0.15, CENTER_Z);
      geos.push(slope);
    }
    const slopes = new THREE.Mesh(mergeSafe(geos), soil);
    scene.add(slopes);
    this.track(scene, slopes);
  }

  /** 统一登记：mesh 挂 scene，几何进清理列表 */
  private track(scene: THREE.Scene, mesh: THREE.Mesh): void {
    this.meshes.push(mesh);
    this.geometries.push(mesh.geometry);
    scene.add(mesh);
  }

  /**
   * 每帧动画：仅贴图 offset 位移（uniform 更新，无 GL 状态切换）。
   * 主流向 −z（与车行同向的缓流），叠加微量 x 摆动防机械循环感。
   */
  update(time: number): void {
    this.colorTex.offset.set(Math.sin(time * 0.1) * 0.006, -(time * 0.022) % 1);
    this.normalTex.offset.set(Math.sin(time * 0.13 + 1.7) * 0.004, -(time * 0.05) % 1);
  }

  /** 释放全部几何 / 材质 / 贴图并移出场景（HMR 与 Game.dispose 语义） */
  dispose(): void {
    for (const mesh of this.meshes) mesh.removeFromParent();
    for (const geo of this.geometries) geo.dispose();
    for (const mat of this.materials) mat.dispose();
    for (const tex of this.textures) tex.dispose();
    this.meshes.length = 0;
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
  }
}
