/**
 * 跨河桥 + 河谷水体（R14 重做）。
 *
 * R13 的问题：水只是路面两侧两条 5.8m 宽、比大地面高 1cm 的窄带，桥是横跨公路的
 * 高架 —— 「桥下」根本没有河，视觉上水=略微反光的地面。R14 把 z≈−450 做成真河谷：
 *
 *   Road 大地面在 x±150 / z±80 开槽（见 Road.ts 的 RIVER 契约）
 *   → 槽内四周护坡从 y=−0.02 斜降到 y=−5.6 河床
 *   → 水面 y=−4.4（水深 1.2m），平面 280×140，边缘压在护坡之下（看不到水边断口）
 *   → 公路在槽上变成桥：桥面板 x±7.4 / z±80 / 厚 0.35，两侧 0.55m 矮墙 + 金属扶手，
 *     两排桥墩（z=−415/−485）从河床插到桥底，水线处加深色湿痕
 *
 * 性能：河谷(护坡+河床, 顶点色) 1 DC + 水面 1 DC + 桥面组 1 DC + 桥墩组 1 DC
 * + 湿痕 1 DC + 扶手 1 DC = 6 DC / 约 210 tri。
 * 动画：update(time) 只改 normalMap.offset（uniform 更新），无顶点上传。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { RIVER, createSoilTexture } from './Road';
import { createWaterBasinTexture, createWaterNormalTexture } from './waterTexture';

const DECK_LEN = RIVER.deckHalfZ * 2;
/** 桥墩排位（沿路方向） */
const PIER_ZS = [-415, -485] as const;
/** 桥墩中心 |x|（在桥面 ±7.4 之内） */
const PIER_X = 6.6;
/** 水面平面外扩量：让水边藏进护坡内部，避免出现可见的矩形水缘 */
const WATER_BLEED = 20;

export class Waterway {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly basinTex: THREE.CanvasTexture;
  private readonly normalTex: THREE.CanvasTexture;

  constructor(scene: THREE.Scene) {
    this.basinTex = createWaterBasinTexture();
    // 水面尺度：280×140 → 单格约 15.6m×15.6m，近岸碎波才读得出流向
    this.normalTex = createWaterNormalTexture();
    this.normalTex.repeat.set(56, 28);
    this.textures.push(this.basinTex, this.normalTex);
    this.buildValley(scene);
    this.buildWater(scene);
    this.buildBridge(scene);
  }

  /**
   * 河谷：四周护坡（4 个梯形面）+ 平底河床，全部顶点写色合为 1 mesh。
   * 外缘与 Road 开槽口严格同点（y=−0.02），护坡把「地面断口」完全盖住。
   */
  private buildValley(scene: THREE.Scene): void {
    const soil = new THREE.Color(0x8a7c72);
    const silt = new THREE.Color(0x5b5249);
    const pos: number[] = [];
    const col: number[] = [];
    const uvs: number[] = [];
    const TILE = 6;
    const v = (p: readonly number[], c: THREE.Color): void => {
      pos.push(p[0], p[1], p[2]);
      col.push(c.r, c.g, c.b);
      // 世界坐标投影 UV：与 Road 大地共用 6m 贴图周期，护坡与地面纹理密度一致
      uvs.push(p[0] / TILE, p[2] / TILE);
    };
    const quad = (
      a: readonly number[],
      b: readonly number[],
      c: readonly number[],
      d: readonly number[],
      color: THREE.Color
    ): void => {
      v(a, color);
      v(b, color);
      v(c, color);
      v(a, color);
      v(c, color);
      v(d, color);
    };

    const y0 = -0.02;
    const { centerZ, holeHalfX: ox, holeHalfZ: oz, bedY, bedHalfX: ix, bedHalfZ: iz } = RIVER;
    // 北岸（z = center+80 → center+50）
    quad([-ox, y0, centerZ + oz], [ox, y0, centerZ + oz], [ix, bedY, centerZ + iz], [-ix, bedY, centerZ + iz], soil);
    // 南岸
    quad([ox, y0, centerZ - oz], [-ox, y0, centerZ - oz], [-ix, bedY, centerZ - iz], [ix, bedY, centerZ - iz], soil);
    // 东岸 / 西岸
    quad([ox, y0, centerZ + oz], [ox, y0, centerZ - oz], [ix, bedY, centerZ - iz], [ix, bedY, centerZ + iz], soil);
    quad([-ox, y0, centerZ - oz], [-ox, y0, centerZ + oz], [-ix, bedY, centerZ + iz], [-ix, bedY, centerZ - iz], soil);
    // 河床（法线朝上）
    const b1 = [-ix, bedY, centerZ - iz];
    const b2 = [ix, bedY, centerZ - iz];
    const b3 = [ix, bedY, centerZ + iz];
    const b4 = [-ix, bedY, centerZ + iz];
    v(b1, silt);
    v(b3, silt);
    v(b2, silt);
    v(b1, silt);
    v(b4, silt);
    v(b3, silt);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: createSoilTexture(),
      vertexColors: true,
      roughness: 0.68,
      metalness: 0.02
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'valley';
    mesh.receiveShadow = true;
    this.materials.push(mat);
    this.add(scene, mesh);
  }

  /**
   * 水面：单张非重复「河心深/近岸浅」渐变贴图 + 可平铺法线流动。
   * 低 roughness（0.13）+ envMapIntensity 1.35 → 黄昏天空在水面上的镜面高光；
   * 半透明让河床透出一点，避免整块塑料板观感。
   */
  private buildWater(scene: THREE.Scene): void {
    const material = new THREE.MeshStandardMaterial({
      map: this.basinTex,
      normalMap: this.normalTex,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.19,
      metalness: 0.55,
      // 低角度司机视角下 Fresnel 会把整片水变成天空的银色镜子（与远处地面分不开）；
      // env 压到 0.5 让水体的青绿色重新主导，太阳路径光保留在直射高光里
      envMapIntensity: 0.75,
      transparent: true,
      opacity: 0.94
    });
    this.materials.push(material);

    const geo = new THREE.PlaneGeometry(
      (RIVER.bedHalfX + WATER_BLEED) * 2,
      (RIVER.bedHalfZ + WATER_BLEED) * 2
    );
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, RIVER.waterY, RIVER.centerZ);
    const water = new THREE.Mesh(geo, material);
    water.name = 'water';
    water.receiveShadow = true; // 桥面板投影落在水面上（判定桥下空间的关键线索）
    this.add(scene, water);
  }

  /**
   * 桥：桥面板 + 两端桥台（混凝土 1 mesh）、两排桥墩 + 帽梁（1 mesh）、
   * 桥墩水线湿痕（1 mesh）、矮墙顶金属扶手（1 mesh）。
   */
  private buildBridge(scene: THREE.Scene): void {
    const concrete = new THREE.MeshStandardMaterial({
      color: 0xb3aea2,
      roughness: 0.88,
      // 桥底朝下、只吃半球光的地面色，纯 PBR 会读成黑洞；给极轻的自发光抬黑
      emissive: 0x14120f,
      emissiveIntensity: 0.9
    });
    const wet = new THREE.MeshStandardMaterial({ color: 0x4d4842, roughness: 0.45, metalness: 0.05 });
    const railing = new THREE.MeshStandardMaterial({ color: 0x9ea3a6, metalness: 0.6, roughness: 0.5 });
    this.materials.push(concrete, wet, railing);

    const { centerZ, deckHalfX, deckTopY, deckThickness, parapetHeight, bedY } = RIVER;
    const deckBottom = deckTopY - deckThickness;

    // --- 桥面板 + 桥台 ---
    const deckGeos: THREE.BufferGeometry[] = [];
    const deck = new THREE.BoxGeometry(deckHalfX * 2, deckThickness, DECK_LEN);
    deck.translate(0, deckTopY - deckThickness / 2, centerZ);
    deckGeos.push(deck);
    for (const side of [-1, 1]) {
      // 桥台：埋在岸坡里的竖向混凝土墙，遮住桥面板与地面的接缝。
      // 顶面压在 y=−0.14（低于地面 −0.02 与路面 0），避免与大地面共面 z-fighting。
      const abutment = new THREE.BoxGeometry(deckHalfX * 2 + 1.6, 3.72, 1.4);
      abutment.translate(0, -2.0, centerZ + side * RIVER.deckHalfZ);
      deckGeos.push(abutment);
      // 桥侧矮墙（混凝土实体，0.55m —— 翻滚车体可以翻过去，不是无限护栏）
      const parapet = new THREE.BoxGeometry(0.32, parapetHeight, DECK_LEN);
      parapet.translate(side * (deckHalfX - 0.16), deckTopY + parapetHeight / 2, centerZ);
      deckGeos.push(parapet);
    }
    const deckMesh = new THREE.Mesh(mergeSafe(deckGeos), concrete);
    deckMesh.name = 'deck';
    deckMesh.castShadow = true;
    deckMesh.receiveShadow = true;
    this.add(scene, deckMesh);

    // --- 桥墩 + 帽梁 ---
    const pierTop = deckBottom - 0.4;
    const pierGeos: THREE.BufferGeometry[] = [];
    const wetGeos: THREE.BufferGeometry[] = [];
    for (const z of PIER_ZS) {
      const cap = new THREE.BoxGeometry(deckHalfX * 2 + 1.2, 0.4, 1.6);
      cap.translate(0, deckBottom - 0.2, z);
      pierGeos.push(cap);
      for (const side of [-1, 1]) {
        const h = pierTop - (bedY - 0.6);
        const pier = new THREE.BoxGeometry(1.7, h, 1.3);
        pier.translate(side * PIER_X, pierTop - h / 2, z);
        pierGeos.push(pier);
        // 水线湿痕：略大于墩身的一圈深色带（上缘 −3.6，下缘 −4.6）
        const stain = new THREE.BoxGeometry(1.78, 1.0, 1.38);
        stain.translate(side * PIER_X, RIVER.waterY - 0.1, z);
        wetGeos.push(stain);
      }
    }
    const pierMesh = new THREE.Mesh(mergeSafe(pierGeos), concrete);
    pierMesh.castShadow = true;
    this.add(scene, pierMesh);
    const wetMesh = new THREE.Mesh(mergeSafe(wetGeos), wet);
    this.add(scene, wetMesh);

    // --- 矮墙顶金属扶手（延续 Road 护栏材质语言） ---
    const railGeos: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const post = new THREE.BoxGeometry(0.1, 0.1, DECK_LEN);
      post.translate(side * (deckHalfX - 0.16), deckTopY + parapetHeight + 0.06, centerZ);
      railGeos.push(post);
    }
    const railMesh = new THREE.Mesh(mergeSafe(railGeos), railing);
    this.add(scene, railMesh);
  }

  /** 统一登记：mesh 挂 scene，几何/材质进清理列表 */
  private add(scene: THREE.Scene, mesh: THREE.Mesh): void {
    this.meshes.push(mesh);
    this.geometries.push(mesh.geometry);
    scene.add(mesh);
  }

  /**
   * 每帧动画：只做法线贴图 offset（uniform 更新）。
   * 水流沿 x（河道横向贯穿视野），所以主位移在 u 方向；叠加微量 v 摆动防机械循环感。
   */
  update(time: number): void {
    this.normalTex.offset.set(-(time * 0.035) % 1, Math.sin(time * 0.16) * 0.012);
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
