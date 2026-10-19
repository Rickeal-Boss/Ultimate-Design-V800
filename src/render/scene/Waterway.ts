/**
 * 跨河桥 + 河谷水体（R14 重做，R18 抬水）。
 *
 * R13 的问题：水只是路面两侧两条 5.8m 宽、比大地面高 1cm 的窄带，桥是横跨公路的
 * 高架 —— 「桥下」根本没有河，视觉上水=略微反光的地面。R14 把 z≈−450 做成真河谷：
 *
 *   Road 大地面在 x±150 / z±80 开槽（见 Road.ts 的 RIVER 契约）
 *   → 槽内四周护坡从 y=−0.02 斜降到 y=−1.45 河床
 *   → 水面 y=−0.14（桥面顶 −0.03 之下 0.11m），平面铺到岸坡与水位交线（±147.5/±77.5）
 *   → 公路在槽上变成桥：桥面板 x±7.4 / z±80 / 厚 0.35，两侧 0.55m 矮墙 + 金属扶手
 *
 * R18：原来 waterY=−4.4 / bedY=−5.6，护坡高差 5.58m。从车内低机位看，30m 宽的
 * 土色坡面在掠射角下铺满整屏，水面被压在坡脚看不见 → 用户截图读成「棕色沙地」。
 * 现在水位抬到桥面下 0.11m、坡高差只剩 1.43m，水线离槽口 2.5m，水面直接从桥边
 * 铺到对岸，桥面与水面几乎齐平。
 *
 * 桥墩：桥面底 −0.38 已低于水位 −0.14，墩身/帽梁/水线湿痕全部没入水下
 * （湿痕盒顶还会穿出桥面 0.26m，是一条真实的视觉 bug），R18 一并删掉。
 *
 * 性能：河谷(护坡+河床, 顶点色) 1 DC + 水面 1 DC + 桥面组 1 DC + 扶手 1 DC
 * = 4 DC / 96 tri（河谷 10 + 水面 2 + 桥面组 60 + 扶手 24）。
 * 动画：update(time) 只改 normalMap.offset（uniform 更新），无顶点上传。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { RIVER, createSoilTexture } from './Road';
import { createWaterBasinTexture, createWaterNormalTexture } from './waterTexture';

const DECK_LEN = RIVER.deckHalfZ * 2;
/** 槽口处的岸顶高度（与 Road 大地面同高） */
const BANK_Y = -0.02;
/**
 * 水缘越过「水位与岸坡交线」的量：向外多铺 0.12m，让水缘压进坡体内部
 * （坡面每米只升 4.8cm，0.12m ≈ 6mm 埋深），避免出现可见的矩形水缘。
 */
const WATER_EDGE = 0.12;

/**
 * 水位与岸坡的交线半宽：岸坡从 (holeHalf, BANK_Y) 线性降到 (bedHalf, bedY)，
 * 求 waterY 落在坡面上的位置。水面平面必须止于这条线附近——水面高于坡面
 * 就会露出一圈悬空的水缘（R14 用「床宽 + 20m」外扩，只适用于水位远低于坡脚）。
 */
function shorelineHalf(holeHalf: number, bedHalf: number): number {
  const t = (RIVER.waterY - BANK_Y) / (RIVER.bedY - BANK_Y);
  return holeHalf - t * (holeHalf - bedHalf);
}

export class Waterway {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly basinTex: THREE.CanvasTexture;
  private readonly normalTex: THREE.CanvasTexture;

  constructor(scene: THREE.Scene) {
    this.basinTex = createWaterBasinTexture();
    // 水面尺度：295×155 → 单格约 3.5m×3.7m（R17 由 5m 加密：掠射角镜像要靠高频波纹打碎）
    this.normalTex = createWaterNormalTexture();
    this.normalTex.repeat.set(84, 42);
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
   */
  private buildWater(scene: THREE.Scene): void {
    // R17 定罪（消去法 verify/r17/water/w_00 红探针）：水面几何/位置正确（右侧红实证），
    // 病根是**黄昏暖光 + 太阳掠射高光把暗青 basin 图整片洗成沙色**。三层修：
    //   ① MeshPhysicalMaterial + specularIntensity 0.35 —— 压掉掠射太阳高光的整片泛白
    //   ② emissive 青绿 1.0 —— 水体自带「这是水」的色相信号，不随场景光色漂移
    //   ③ basin 图源提亮加饱和（waterTexture.ts）+ 法线加密打碎镜像
    // R18：水位抬到桥面下 0.11m 后视线更贴水面（掠射角更极端），
    // 半透明会让水下 3% 的河床褐土透上来把青绿洗暖，故改为完全不透明，envMap 再压低。
    const material = new THREE.MeshPhysicalMaterial({
      map: this.basinTex,
      emissive: 0x18707c,
      emissiveIntensity: 1.0,
      normalMap: this.normalTex,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.22,
      metalness: 0.1,
      specularIntensity: 0.35,
      envMapIntensity: 0.08
    });
    this.materials.push(material);

    // R18：水面只铺到「水位与岸坡的交线」外 0.12m（见 shorelineHalf）。
    // 原「床宽 + 20m」的水缘在新水位下会悬在坡面之上 0.36m，形成一圈水墙。
    const halfX = shorelineHalf(RIVER.holeHalfX, RIVER.bedHalfX) + WATER_EDGE;
    const halfZ = shorelineHalf(RIVER.holeHalfZ, RIVER.bedHalfZ) + WATER_EDGE;
    const geo = new THREE.PlaneGeometry(halfX * 2, halfZ * 2);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, RIVER.waterY, RIVER.centerZ);
    const water = new THREE.Mesh(geo, material);
    water.name = 'water';
    water.receiveShadow = true; // 桥面板投影落在水面上（判定桥下空间的关键线索）
    this.add(scene, water);
  }

  /**
   * 桥：桥面板 + 两端桥台 + 两侧矮墙（混凝土 1 mesh）、矮墙顶金属扶手（1 mesh）。
   *
   * R18：桥面底 −0.38 低于水位 −0.14，桥墩/帽梁整根没入水下，水线湿痕盒顶
   * （waterY−0.1+0.5=+0.26）还会穿透 0.35m 厚的桥面顶出路面 —— 已删。
   * 现在桥在水位处读作一块贴水的桥板（低水位桥 / causeway），桥边即水面。
   */
  private buildBridge(scene: THREE.Scene): void {
    const concrete = new THREE.MeshStandardMaterial({
      color: 0xb3aea2,
      roughness: 0.88,
      // 桥底朝下、只吃半球光的地面色，纯 PBR 会读成黑洞；给极轻的自发光抬黑
      emissive: 0x14120f,
      emissiveIntensity: 0.9
    });
    const railing = new THREE.MeshStandardMaterial({ color: 0x9ea3a6, metalness: 0.6, roughness: 0.5 });
    this.materials.push(concrete, railing);

    const { centerZ, deckHalfX, deckTopY, deckThickness, parapetHeight } = RIVER;

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
