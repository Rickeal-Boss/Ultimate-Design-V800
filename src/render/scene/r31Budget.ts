/**
 * R31 预算键（B 线 · 运行时流畅度 + 贴图治理）。
 *
 * ── 为什么另起一个文件 ────────────────────────────────────────────────
 * R30 审查 P0：「预算键零消费」——`R27_BUDGET` / `R30_BUDGET` 四个键只被注释引用，
 * 没有任何测试或断言消费，CI 拦不住超标。R31 重开一套键，并由
 * `tests/r31_budget.test.ts` **真正消费**（断言失败会红，已验证）。
 *
 * ── 旧键废弃声明 ──────────────────────────────────────────────────────
 * **`R27_BUDGET` 与 `R30_BUDGET`（`src/render/scene/r28Layout.ts`）自 R31 起
 * 标记 DEPRECATED**：只剩注释引用（castleKit.ts / Terrain.ts / r28Layout.ts 头注）。
 * 新代码一律消费 `R31_BUDGET`；旧键的值本轮**不作修改**（R31 白名单不含 r28Layout.ts，
 * A 线正在并行编辑该文件，为规避写盘竞态，废弃声明只落在本文件，不落到 r28Layout.ts）。
 * 待 A 线交付后由主理人安排一次性清理。
 *
 * ── 口径 ──────────────────────────────────────────────────────────────
 * tri：castle = 已装配几何口径（`getCastleStats().tris`，即 merge 之后）；
 *      frame = 渲染器整帧口径（`renderer.info.render.triangles`，含阴影 pass，
 *      **本场景无 transmission 材质 ⇒ 不存在透射 pass 使 DC 翻倍**，
 *      与 R12 铁律⑤「玻璃不走 transmission」一致）。
 * DC：castle = castle 组的非阴影 draw call 数（每 mesh 一次，**不含阴影 pass**）；
 *      frame = `renderer.info.render.calls`（**含阴影 pass + 后处理全屏 pass**）。
 * 可见量：行车段 `renderer.info.render.{calls,triangles}`（视锥剔除后的实测量）。
 *
 * ── 基线实测（fresh-vs-fresh，.qa/r31_test/baseline.md @ main 48ea186）──
 *   castle high 238,630 tri / 7 DC；low 181,550 / 7；几何生成 364ms（high）
 *   makeInnerCity 独占 174,000 tri = 73%
 *   整帧 DC 188（p50）/ 188（max），tri 321,091（p50）/ 344,399（max）
 *   阴影 pass 约 26~29 DC
 *   冻结阴影更新（#noshadowupd）后帧时降约 60% ⇒ 2048² 每帧重绘是最大单项帧成本
 *   石材族贴图：目标代 12 张 + 同步代 12 张 = 24（.qa/r31_review/baseline.md §5）
 *
 * ── R31 交付实测（fresh-vs-fresh，.qa/r31_test/r31_geo_probe.json @ 工作树）──
 *   castle high **312,118 tri / 18 DC**（R30b 238,630 ⇒ +73,488 = FBX 级构件精化
 *     ≈+40k + 内部建筑群加密 ≈+33k）
 *   castle low  **217,578 tri / 18 DC**（铁律 33：只降装饰密度，几何长度不变）
 *   DC 7 → 18：B 线 z-zone 合批（ashlar 6 区 + wall 3 区 + gold/dark/flame 各 1 +
 *     四新桶 4）= 用 DC 换视锥剔除收益。makeInnerCity 独占 241,064 tri = 77%。
 *   下方阈值全部按「实测 ×1.15 安全余量」设定，并额外覆盖剩余 R31 细化项。
 *
 * ── 阈值与余量说明 ────────────────────────────────────────────────────
 * 用户口径：**首次构建时长无限制，运行时必须流畅**。故 tri 上限放宽（构建可铺量），
 * 而 DC / 可见 tri / 贴图张数 / 阴影更新频率一律收紧（这些才是逐帧成本）。
 */
export const R31_BUDGET = {
  /**
   * castle high tri 上限 400,000。
   * 实测（A 线细化落地后，r31_geo_probe.json）：353,566（R30b 238,630 ⇒ +114,936 =
   * FBX 级构件精化 + 内部建筑群加密 + 飞扶壁/连廊/垂幔/壁龛立像/尖顶等细节）。
   * 余量 ~46k（13%）留给落地审查可能追加的细节（用户口径「tri 非瓶颈 / 构建可铺量」）。
   * 本键仅作**灾难性回归护栏**（误翻倍 / 漏掉 far-z 减法等），不做刻意卡量。
   */
  castleTriHigh: 400_000,
  /**
   * castle low tri 上限 285,000。
   * 实测 242,290（R30b 181,550 ⇒ +60,740）；low 同步 high 的细化，铁律 33 只降装饰密度。
   * 余量 ~43k（18%）。
   */
  castleTriLow: 285_000,
  /**
   * castle DC 上限 32。
   * ⚠ 基线实测是 **7**（5 桶 + 铺装 2），R27_BUDGET 的 20 是遗留上限而非实测值。
   * R31 分区合批后：ashlar 6 区 + wall 3 区 + gold/dark/flame 各 1 + 四新桶 4 = 18，
   * 这是**用 DC 换剔除**的主动加价，故上限抬到 32（余量 14）。
   * 判据不写 20：20 会在四桶补满后误杀分区收益。
   */
  castleDc: 32,
  /**
   * 整帧 tri 上限 465,000（renderer 实测口径，含阴影 pass）。
   * 估算 = 车 82,310 + castle 312,118 + terrain ≈6.8k + road ≈23k ≈ 424k，×1.10 ≈ 465k。
   * 注：frame tri 需 WebGL 渲染读数，本单测不断言；由 `.qa/r31_test/r31_perf*.mjs`
   * 运行时探针把关（与 castleTriHigh 同口径）。
   */
  frameTri: 465_000,
  /**
   * 整帧 DC 上限 188 = **基线不增**（含阴影 pass + 后处理）。
   * ⚠ 基线 188 已越 R27 遗留红线 150，属既有状态；本轮按「不增」卡，不按 150 卡。
   * 分区合批会让 castle 的静态 DC 从 7 涨到 ~18，但**可见 DC 大降**（视锥剔除生效），
   * 整帧 DC 的目标是净持平或下降。
   */
  frameDc: 188,
  /**
   * 城堡石材族贴图张数上限 20（GPU 常驻的 THREE.Texture 实例数，含两代中的存活代）。
   * 治理口径修正（审查线复核）：基线全场景唯一纹理 **46 张 / 91.2MB**（tex_inventory.json，
   * 非此前误估的 25 张），其中石材/城堡族是重灾区。R31 治理后稳态：
   *   ashlar3 + gold3 + roof2 + marble2 + floor2 + wood1 + glass1 = **14 张**（wall 别名 ashlar
   *   共享三张、rock 未进场景故 0）。14 ≪ 20 ⇒ 留 6 张余量覆盖后续细化。
   * 峰值（热替换过渡期）短暂 28（两代同驻），但仍 ≤20 的长期稳态护栏由本键卡住。
   * 详见 .qa/r31_b/report.md 的「贴图数量前后对照表」。
   */
  castleTexCount: 20,
  /**
   * 城堡石材族贴图显存上限 40MB（GPU 常驻 THREE.Texture 实例估算：张数 × 边长² × 4 通道 × 1.33 mip）。
   * 治理目标（审查线复核）46 张 / 91.2MB → ≤20 张 / ≤40MB。
   * 稳态 14 张（high 档 ashlar/gold 1024²、其余 512²）估算 ~21MB，low 档全 256² ~3MB，
   * 均 ≪ 40MB；过渡期两代同驻峰值 ~42MB 属瞬时，稳态回到 ≤40MB。
   */
  castleTexMB: 40,
  /**
   * 行车段可见 tri 上限 120,000（renderer 实测，视锥剔除后）。
   * 基线未测（只有整帧 321k~344k）；R31 分区合批后的目标值，是本线主战指标。
   */
  visibleTri: 120_000
} as const;
