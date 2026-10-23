/**
 * 跨河桥 + 河谷水体 —— **R27 已整类停用（空操作）**。
 *
 * ── 为什么停用（用户指令：「先去除以前的旧版环境残留，完全使用新环境模型」）──────
 * R14–R18 的河谷（河床 / 护坡 / 水面 / 跨河桥面）在 z ≈ −450、水面 y = −0.14，
 * 是**与路面几乎平齐的一大片青绿色矩形** —— R26 实拍里它是旧环境最刺眼的残留。
 * 新布局（r27Layout.ts）里 z ∈ [−365.5, −1350] 是**城内大街**（INNER），地面实体：
 *   · 参考包官方渲染图在这个区段是石板大街 + 两侧建筑，没有任何水体；
 *   · 御桥是 z ∈ [+60, −358.5] 的高架桥，与 z ≈ −450 无交集。
 * ⇒ 水面 / 护坡 / 河床 / 跨河桥面全部不再建几何。
 *
 * ── 停用方式（重要，别改错地方）─────────────────────────────────────────
 * 本轮**不动 `src/core/Game.ts`**（另一条线正在改相机/座舱，冲突会炸），所以
 * `new Waterway(scene)` / `waterway.update(t)` / `waterway.dispose()` 三条调用全部
 * 保留原样 —— 停用**在类内部**实现：构造不建任何几何、update 不改任何 uniform、
 * dispose 空转。这样调用方零改动，也随时可以把几何加回来。
 *
 * ── 冻结契约（不许动）───────────────────────────────────────────────────
 * `Road.ts` 的 `RIVER` 导出（centerZ −450 / holeHalf 150×80 / waterY −0.14 …）
 * 与 `src/physics/World.ts` 的 `RIVER_CENTER_Z = −450 / RIVER_HOLE_HALF_Z = 80`
 * 是**物理契约**（vitest 盯着）。视觉层停用 ≠ 改契约，两边都保持原值。
 * 相应地 `Road.buildGround` 也不再为 RIVER 挖洞（改为给御桥峡谷走廊挖洞）。
 *
 * R28 备注：旧注释提到的 castle.ts `RAIL_SEGMENTS` / `PAVE_SEGMENTS` 已不存在
 * （R27 castle 重写时移除，grep 0 命中）——该遗留项已自然消失，勿据此改代码。
 */
import * as THREE from 'three';

/** R27 停用开关：true = 建几何（旧行为），false = 空操作（当前） */
const WATERWAY_ENABLED = false;

export class Waterway {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  constructor(scene: THREE.Scene) {
    if (!WATERWAY_ENABLED) return;
    // 旧实现（河谷 + 水面 + 桥面）已整体下线；要恢复就把 buildValley / buildWater /
    // buildBridge 三个私有方法连同 waterTexture 的两个 import 一起搬回来。
    void scene;
  }

  /** 每帧动画：几何已停用，无 uniform 可改 */
  update(time: number): void {
    void time;
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
