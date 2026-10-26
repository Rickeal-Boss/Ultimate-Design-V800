/**
 * 路面与路侧：14m 石板铺装大道，**连续贯穿桥头（z=+260）→ 城门隧道 → 城内大街 →
 * 主殿正面（MAIN_HALL.z = −1300）**，不做尽头截断（用户「路的距离无限制」解读）。
 * 移植自原版 hg/gg/_g/vg/yg/bg/xg 的几何语义（路面 / 路缘 / 大地），
 * 材质语汇演进：
 *
 *  R26：关掉金属波形梁护栏 + 黑色双臂路灯杆（改由 castle 的石栏板 + 栏板灯柱接管）。
 *  R27：① 沥青贴图 + 车道虚线/中线/白边线/黄边线 → 全部删除，改**石板铺装**贴图；
 *       ② 施工/封闭/玩法标牌（现代反光牌 + 金属立杆）删除；
 *       ③ 大地面不再给 RIVER 开槽（旧河流水面已停用 —— R32 C-6 起连 `Waterway.ts`
 *          都整类删除了），改为给**御桥峡谷走廊**开槽
 *          （|x| ≤ VIADUCT.totalHalf / z ∈ [VIADUCT.zFar, VIADUCT.zNear]），
 *          峡谷内衬岩壁由 Terrain.ts 负责（本文件只负责"不铺地面"）。
 *  R28（本轮，V H7「现代施工语汇全部删除」+ audit §1 残留清单）：
 *       ④ buildBarriers（7 块混凝土路障 + 「道路封闭 ROAD CLOSED」横幅 + 双金属立杆）
 *          + stripeTexture + barrierBlocks 字段**整删** —— 撞击目标换主殿实心立面
 *          （CRASH_WALL.z = −1300），数值契约 TRACK.barrierDistance=1300 本身冻结不动；
 *       ⑤ buildWarningLights（橙色呼吸灯球）与 update() 闪烁逻辑整删，update 留空壳
 *          （Game.ts 的调用摘除归 L4 线）；终点语义由主殿立面 + 火盆阵（H5）承担；
 *       ⑥ buildCurbs 混凝土灰 0x9a949a → 白石 ashlar（R27_PALETTE.stoneWhite）；
 *       ⑦ 三带铺装落进 roadTexture（V §7.2：中央深色 0.333W + 两侧浅色 0.333W），
 *          石板拼缝加强（G10「拼缝弱」）；roughness 0.9 均匀、**不用 roughnessMap**
 *          （铁律 34：400m 水平面镜反射教训）；
 *       ⑧ 视觉路面/curb 收口到 MAIN_HALL.z = −1300（主殿正面=撞击面，其后由主殿
 *          遮挡）；roadEnd=−2000 只作远景地面兜底，curb/路面不越过 −1300。
 *
 * ⚠ `RIVER` 常量块是**冻结契约**：`src/physics/World.ts` 有一份同名的河谷开槽数值
 *   （RIVER_CENTER_Z = −450 / RIVER_HOLE_HALF_Z = 80），物理线会 import（vitest 盯着）。
 *   「视觉层停用河谷」≠ 改契约：R27 起不再开槽、R32 C-6 已把 `Waterway.ts` /
 *   `waterTexture.ts` 整类删除，**本常量块仍作为几何/物理契约存在**（详见下方
 *   `RIVER` 头注），故字段与数值一个都不许动。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { TRACK } from '../../config/physics';
import { canvasTexture, makeCanvas, paintNoise } from '../../util/canvasTex';
import { makeLcg } from '../../util/math';
import { MAIN_HALL, R27_PALETTE, VIADUCT } from './r28Layout';

/**
 * 河谷几何契约（R14 订立，**R32 C-6 起只剩契约、视觉层实现已删除**）。
 *
 * 旧版水只是「路面两侧 1cm 高的反光地面」，桥是横跨公路的高架，二者无水体关系。
 * R14 把 z≈−450 改造成真正的河谷：Road 的大地面在此开一个矩形槽（x ±150 /
 * z ±80），当年由 `src/render/scene/Waterway.ts` 在槽内做「河床 + 四周护坡 +
 * 水面 + 跨河桥面」。槽口边缘与护坡外缘严格同点同高（y=−0.02），避免看到地面断口。
 *
 * R18：水面由 −4.4 抬到 −0.14（桥面下 0.11m）、河床由 −5.6 收到 −1.45。
 *
 * ⚠ R27 冻结 + R32 C-6 删除后的现值：
 *   · R27 起视觉层就不再开槽 —— 新布局里 z≈−450 落在城内大街
 *     （INNER.zNear=−365.5 → INNER.zFar=−1350）范围内，是实体地面；
 *     `Road.buildGround` 也不再为 RIVER 挖洞（改为给御桥峡谷走廊挖洞）。
 *   · **R32 C-6 已删除 `Waterway.ts` 与其配套贴图 `waterTexture.ts`**
 *     （该类自 R27 起在类内部整类停用 —— 构造不建几何 / update 空转 / dispose 空转，
 *     长期空跑后一次性删除；`Game.ts` 的 import/字段/构造/update×2/dispose 六条接线
 *     同步摘除，patch 清单见 `.qa/r32_tmp_audit/c2_closeout.md` §2，
 *     现存零残留由 `tests/r32_waterway.test.ts` 盯住）。
 *   · 故本常量块**只作为几何/物理契约存在**，现存消费者是
 *     `src/physics/World.ts` 的 `RIVER_CENTER_Z = −450` / `RIVER_HOLE_HALF_Z = 80`
 *     （vitest 盯着），Road 侧保持同名同值与其对账。
 *   · 改这里不会有任何画面效果，但**会**破坏物理契约的同步口径 ⇒ 数值一个都不许动。
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
export function createSoilTexture(): THREE.CanvasTexture {  const size = 256;
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

/**
 * 石板铺装贴图（R27 起，R28 落三带 + 加强拼缝）。
 *
 * 删掉的东西（用户判定的旧版环境残留，现代公路语汇）：
 *   · #2a2a2d 沥青底 + 三车道深色轮辙带（±3.6 / 0）
 *   · 车道虚线（±1.8，半幅 440px 断续）
 *   · 白色边线（±5.4）与黄色边线（±6.6）
 * 留下的东西：石块拼缝 + 逐块条石的明暗抖动（**石块拼缝（非连续路面）**，
 * vision §01 `7cd7329c` 明文要求）。
 *
 * 三带（R28，V §7.1/§7.2）：横向三等分，与 castleKit.makePaving 的三带同口径 ——
 *   · 中央 0.333W 车行带 albedo `#413f3d`（R27_PALETTE.roadDark）；
 *   · 两侧各 0.333W 边带 albedo `#bdb3a4`（V §7.2 路面边带；受光 lit `#B9A89A`
 *     = R28_PALETTE.kerbLit）。
 * makePaving（y=0.012）盖在本贴图之上时分带边界对齐、不跳带；makePaving 收口
 * 之后（或其外缘与主殿之间）露出的本贴图延续同一条三带，路面连续不截断。
 *
 * 拼缝（G10「拼缝弱」加强）：缝宽 3px → **4.5px**、缝色 alpha 0.5 → **0.72**
 * （rgba(18,17,16)），逐块明暗抖动 alpha 0.16 → 0.2 —— 参考图 7cd7329c 近景
 * 桥面要能清晰读出石块分割线。
 *
 * 色：roadDark 是**深炭**（L≈64 = 白石 L≈220 的 0.29），做成中灰整条大道会相对
 * 参考图发白。细节对比 4.7（白石 6.9 / 岩石 13.7）⇒ 铺装的明暗抖动必须比岩石弱一档。
 *
 * 尺度：贴图横向 1024px = 路宽 14m ⇒ 73.1px/m；纵向 880px = 一个 repeat 周期，
 * 由调用方 repeat.set(1, length/12) 定为 12m ⇒ 73.3px/m。两向密度一致，
 * 故 2.4m 条石（与 castleKit 的 BRIDGE.paveTile 同尺度）≈ 176px 正方形。
 */
function roadTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 1024;
  const height = 880;
  const [canvas, ctx] = makeCanvas(size, height);
  // 三带底色：两侧浅边带先铺满，中央深车行带压上（V §7.2）
  const band = Math.round(size / 3);
  ctx.fillStyle = '#bdb3a4';
  ctx.fillRect(0, 0, size, height);
  ctx.fillStyle = '#413f3d';
  ctx.fillRect(band, 0, size - 2 * band, height);
  paintNoise(ctx, size, height, 60000, 0.22);

  const pxPerM = size / TRACK.roadWidth;
  const tile = pxPerM * 2.4; // 2.4m 条石
  const random = makeLcg(4471);

  // 逐块条石的明暗抖动（±11%，低于白石的 ±13% —— 铺装细节对比 4.7 更弱）
  for (let y = 0; y < height; y += tile) {
    for (let x = -tile; x < size + tile; x += tile) {
      const g = Math.floor(-14 + random() * 28);
      ctx.fillStyle = `rgba(${128 + g},${128 + g},${128 + g},0.2)`;
      ctx.fillRect(x, y, tile, tile);
    }
  }
  // 灰缝：错缝砌（每行错半块）——G10 加强：更宽更深的缝，石块分割线要读得出来
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = 'rgba(18,17,16,0.72)';
  for (let row = 0, y = 0; y <= height; y += tile, row += 1) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
    for (let x = (row % 2 ? tile / 2 : 0) - tile; x < size + tile; x += tile) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + tile);
      ctx.stroke();
    }
  }

  const tex = canvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

export class Road {
  constructor(scene: THREE.Scene, anisotropy: number) {
    const roadStart = 260; // 原版 lg
    /**
     * 远景地面兜底远端（原版 ug）。R28 路端统一（audit §3）：视觉路面/curb 收口到
     * MAIN_HALL.z = −1300，**roadEnd=−2000 只留给大地**做主殿身后的远景兜底
     * （地面 y=−0.02 被主殿整体遮挡，不存在截断线）。
     */
    const groundEnd = -(TRACK.barrierDistance + 700); // −2000
    const groundCenter = (roadStart + groundEnd) / 2;

    /** 视觉路面/curb 远端 = 主殿正面 = 撞击面（B：其后由主殿遮挡，不做尽头截断） */
    const roadFar = MAIN_HALL.z; // −1300
    const roadLength = roadStart - roadFar;
    const roadCenter = (roadStart + roadFar) / 2;

    // 大地（R27：改为绕**御桥峡谷走廊**开槽，4 块拼合并为 1 DC）
    this.buildGround(scene, groundCenter);

    // 主路面（三带石板铺装，连续贯穿桥头 → 主殿立面）
    const tex = roadTexture(anisotropy);
    tex.repeat.set(1, roadLength / 12);
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(TRACK.roadWidth, roadLength),
      new THREE.MeshStandardMaterial({
        map: tex,
        // 干石材（不是湿沥青镜面）：逆光低太阳（仰角 12°）下 0.5/0.45 会把整片路面
        // 打成一条反光镜（verify/r26c/chase.png 实证）。石板是哑光糙面 ⇒
        // roughness 0.9 均匀、**不用 roughnessMap**（铁律 34：400m 水平面镜反射教训）。
        roughness: 0.9,
        metalness: 0.04,
        envMapIntensity: 0.15
      })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, roadCenter);
    road.receiveShadow = true;
    road.name = 'road';
    scene.add(road);

    this.buildCurbs(scene, roadCenter, roadLength);
    // R26 起：金属波形梁护栏 / 黑色双臂路灯杆已删除（castle 石栏板 + 栏板灯柱接管）。
    // R27 起：施工/封闭/玩法标牌（现代反光牌 + 金属立杆）删除。
    // R28 起（H7）：buildBarriers（路障块 + ROAD CLOSED 横幅）与 buildWarningLights
    // （终点呼吸灯球）也全部删除 —— 撞击目标 = 主殿实心立面（CRASH_WALL.z=−1300），
    // 终点语义由主殿立面 + 火盆阵（MAIN_HALL/HALL_BRAZIER）承担。碰撞护栏在 physics
    // 里独立存在，不受影响；TRACK.barrierDistance=1300 数值契约冻结不动。
  }

  /**
   * 大地：在 3000×6000 平面上挖出**御桥峡谷走廊**，拆成四块后 mergeSafe 合为 1 mesh。
   *
   * R14–R26 挖的是 RIVER 河谷槽口（x ±150 / z −530..−370）；R27 河谷已停用、
   * 那一段归城内大街（实体地面），改为挖御桥走廊：
   *   |x| ≤ VIADUCT.totalHalf (16.72) 且 z ∈ [VIADUCT.zFar (−358.5), VIADUCT.zNear (60)]
   * 理由（用户 + 几何线共同约束）：
   *   ① 御桥是**高架桥**，桥面 y=0 与路面同高 ⇒ 走廊里再铺一层 y=−0.02 的地面会
   *      与桥面结构 z-fighting；
   *   ② 地面盖住走廊就看不见桥下峡谷（VIADUCT.gorgeDepth 深，R28 实测 66.5m），
   *      "高架桥"读不出来。
   *
   * ⚠ 只挖 `ground`，**不挖 `road` 本体**（|x| ≤ 7.4 的行车面）：物理地面 y=0 全程
   *   存在，车照旧稳稳跑；视觉上挖空只是露出下方峡谷（峡谷内衬岩壁见 Terrain.ts）。
   *
   * 四块与峡谷内衬在槽口边缘同点同位（y=−0.02），接缝埋在崖口棱线上。
   */
  private buildGround(scene: THREE.Scene, center: number): void {
    const holeNear = VIADUCT.zNear; // +60（车行上游侧 = 车后方）
    const holeFar = VIADUCT.zFar; // -358.5（= GATE.z，城门中心）
    const holeHalfX = VIADUCT.totalHalf; // 16.72
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
    // 北块（车后方整幅，z ∈ [+60, +2130]）
    pieces.push(slab(3000, northEdge - holeNear, 0, (northEdge + holeNear) / 2));
    // 南块（城门以南整幅，z ∈ [−3870, −358.5]，含原河谷段 —— 那里已恢复实体地面）
    pieces.push(slab(3000, holeFar - southEdge, 0, (southEdge + holeFar) / 2));
    // 西 / 东两块（走廊 ±16.72 之外，z ∈ [−358.5, +60]）
    const sideW = 1500 - holeHalfX;
    for (const side of [-1, 1]) {
      pieces.push(slab(sideW, holeNear - holeFar, side * (holeHalfX + sideW / 2), (holeNear + holeFar) / 2));
    }
    // R26：地面贴图曾经完全没有 repeat —— 256² 的土壤噪点被拉伸到 ~2000m 见方的
    // 大地上，等于一张纯色（俯瞰图 verify/r26b/aerial.png 里整片死褐色，无任何细节）。
    // 现在按 8m 一格平铺（约 250 次重复），让地面在 100m 高空也能读出颗粒与斑块。
    const soil = createSoilTexture();
    soil.wrapS = THREE.RepeatWrapping;
    soil.wrapT = THREE.RepeatWrapping;
    soil.repeat.set(250, 250);
    soil.anisotropy = 8;
    const ground = new THREE.Mesh(
      mergeSafe(pieces),
      new THREE.MeshStandardMaterial({
        // R26：大地从「暖棕沙漠土」(0x8a7c72) 收到偏中性的石灰岩基色 0x5c544b。
        // 参考图里城堡外的地面是灰褐岩体（受光 #a5947d），旧土色在新冷调天光下
        // 会整片发橙、把白石衬成脏黄，故整体降饱和降亮度；贴图仍复用土壤噪点，
        // 只提供 8m 尺度的细节，不提供色相。
        color: 0x5c544b,
        map: soil,
        roughness: 0.72,
        metalness: 0.03
      })
    );
    ground.name = 'ground';
    ground.receiveShadow = true;
    scene.add(ground);
  }

  /**
   * 路缘石（R28 换语汇不换位置，audit §1.3）：0.4×0.14 石条沿路两侧（±7.2），
   * 几何上填补 Road 路面与 castle 步道之间的 0.4m 接缝，位置/截面一个都不动。
   * 材质：R27 的 0x9a949a 混凝土灰是现代公路语汇（V H7 判删）→ **白石 ashlar**
   * （R27_PALETTE.stoneWhite，与 castle 步道 ashlar 同族；备选是并入 makePaving
   * 边带 #bdb3a4 语汇，见 .qa/r28_l2_report.md）。
   * 长度收到主殿正面 MAIN_HALL.z（−1300）为止，不越过主殿。
   */
  private buildCurbs(scene: THREE.Scene, center: number, length: number): void {
    const mat = new THREE.MeshStandardMaterial({ color: R27_PALETTE.stoneWhite, roughness: 0.8 });
    for (const side of [-1, 1]) {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, length), mat);
      curb.position.set(side * (TRACK.roadWidth / 2 + 0.2), 0.07, center);
      curb.receiveShadow = true;
      scene.add(curb);
    }
  }

  /**
   * R28：终点警示灯（橙色呼吸灯球）已随 H7 整删，闪烁逻辑随之清空。
   * 方法留壳是因为 `Game.ts:672` 仍调 `road.update(this.time)`（调用摘除归 L4 线，
   * 本线不碰 Game.ts）；空壳零成本。
   */
  update(time: number): void {
    void time;
  }
}
