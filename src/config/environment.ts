/**
 * 环境参数真源（R26「白石城堡 · 逆光暴风天光」）
 *
 * 为什么单独开这个文件：R26 之前，天空渐变、雾、三盏灯、三块 PMREM 柔光板、车漆
 * envMapIntensity 全都硬编码在 Environment.ts / Lighting.ts / theme.ts 里，改一个
 * 「太阳高度」要动三个文件，且谁都说不清当前这组数值是哪一轮调出来的。这里把
 * **一份 preset 作为唯一参数真源**，Environment / Lighting 只做「按 preset 铺开」。
 *
 * 本文件只 import 三处之外什么都不依赖（Color 用 number 常量，不构造对象），
 * node QA 也能直接读数值做对比。
 *
 * ── 本版依据（参考包官方渲染图 1280×720 的逐像素中位采样，非估算）──────────
 * 塔身受光面 #ded2c0(211) / 背光面 #4a4441(69) / 翼楼阴影 #5c5554(86)
 * 石桥路面 #393431(53) / 栏板阴影 #272219(34) / 城门拱洞 #171310(20)
 * 天空天顶 #494c5d(77) / 天空左上 #61585d(90) / 城堡正后地平线暖晕 #beb098(177)
 * 远山受光 #a5947d(150) / #b79f83(162) / 金色中位 #a38455(p90 #c9a268，占 2.9% 面积)
 *
 * 关键判读：**这是逆光**（光源在城堡后方 = 正对玩家视线），正面进柔光阴影、塔身靠亮边勾轮廓；
 * 天空在城堡正后方有一道暖白地平线光晕（#beb098→近 #fff5e6），往上迅速转冷蓝灰（#494c5d）。
 * 不是黄昏粉紫，也不是正午 —— 是暴云/日落后的戏剧天光：**天顶冷、地平线暖**。
 * 石材 albedo 暖（#ded2c0）+ 照明冷 = 白石的经典组合。
 */

export interface EnvPreset {
  id: string;
  sun: { elevationDeg: number; azimuthDeg: number; color: number; intensity: number };
  sky: { zenith: number; mid: number; horizon: number; ground: number; sunColor: number; cloudAmount: number };
  fog: { color: number; density: number };
  hemi: { sky: number; ground: number; intensity: number };
  fill: { color: number; intensity: number };
  rim: { color: number; intensity: number };
  softbox: Array<{ pos: [number, number, number]; w: number; h: number; color: number; gain: number; alongZ: boolean }>;
}

/**
 * R28：`paintEnvGain` 死表**删除**（R27 遗留 P0：`resolvePaintEnvGain` 全库零消费，
 * grep 仅 environment.ts 自引用）。车漆/材质族的 envMapIntensity 现行真源是
 * spec 工厂产出值 + `V800Adapter.ts` 的 0.55/0.45 硬编码（黑漆压/金属提）——
 * 语义与旧表一致（黑漆怕洗白 → 压；金属怕死黑 → 提），look-dev 调这两处即可。
 * 若未来要按材质族细调再接回消费链（Game/Adapter 里乘 envMapIntensity），
 * 到那时重新加表，不要留无人消费的死配置（铁律 35）。
 */

/** 白石城堡 · 逆光暴风天光（数值依据见文件头采样表；允许 ±10% 微调） */
const WHITE_CATHEDRAL: EnvPreset = {
  id: 'white-cathedral',
  sun: {
    // 仰角 12°：太阳压得很低（逆光），掠射光只擦亮塔身边缘与云底，
    // 城堡正面属于「柔光阴影」，亮度靠 hemi 0.34 + fill 0.70 托住。
    elevationDeg: 12,
    // 方位 195°：方向实测 (−0.2531, 0.2079, −0.9448) —— −Z（城堡方向）偏 −X。
    // 它同时满足两件事（这是 R26h 定稿的**唯一**理由，别再写成「车右侧受光」）：
    //  ① **城堡逆光**：太阳在 −Z 侧 ⇒ 城堡正面柔光阴影、塔缘吃侧掠光、地平线暖晕在城堡正后；
    //  ② **3/4 后侧轮廓光**：相机在 +X 朝 −Z 看，太阳在 −X ⇒ 受光的是车身**左（背对相机）侧**，
    //     于是车身靠一条 3/4 后侧轮廓把剪影「勾」出来，而不是整块死黑。
    // 注意（R26b 曾搞反过一次）：太阳在 −X **不会**让相机侧受光；相机侧的形体由
    // fill（补光在 −dir 侧 = +X）+ rim 公式（固定 +X 侧）负责，见 Lighting.ts。
    // 历史：20° 落在 +Z（车尾后方）= 顺光打城堡，逆光关系全反；165° 修正了逆光但暖晕偏在一侧。
    azimuthDeg: 195,
    // 逆光下正面不该被主光打亮；2.2 → 2.6 是为了在 hemi 降到 0.34 后把受光面拉回来
    color: 0xffe6c8,
    intensity: 2.6
  },
  sky: {
    // 天顶冷。注意口径：参考图采样到 #494c5d(77) 是**tonemap 之后的像素**，
    // 而 Uniform 里要填的是 tonemap **之前**的授权色。直接填采样值会暗 40 级
    // （渲染器是 ACESFilmic + exposure 0.85，见 Renderer.ts）—— 用 tools/r26_sky_predict.mjs
    // 做 ACES 反演后，0x4e5468 渲染出来落在 L=70（比采样 77 略暗，给整片天空留层次）。
    zenith: 0x4e5468,
    // 中段蓝灰：同样反演后取 0x585e6e（渲染 L≈75，采样 90 是云缝间天光，整片天空要比它暗）
    mid: 0x585e6e,
    // 地平线暖：采样 #beb098(177) 的暖白晕 → 0xc9bba6 再抬 15% = 0xd8c9b2。
    // 抬亮是因为暖晕主体由 shader 的 bandHalo 生成，horizon 只是它的底色；
    // 底色太暗时 cloud 混色会把整条带压回去（R26b 实证：approach 里读不出暖带）。
    horizon: 0xd8c9b2,
    // 球体下半（地面方向）：暖深褐，反射到车底的间接光不发蓝
    ground: 0x4b4038,
    // 太阳自身色：采样亮核近 #fff5e6 → 取 0xfff0d8
    sunColor: 0xfff0d8,
    // 云量 0.85（重云，参考图整片云幕只有城堡正后方一处透光）：
    // 云必须读得出层理 —— 见 Environment.ts 里「亮边 / 暗底两段映射」的云结构
    cloudAmount: 0.85
  },
  fog: {
    // 采样：远景塔尖在霾里仍可辨。0xa89c8e → 0x9c9384（略暗、略中性）：
    // 偏亮偏黄的雾会把白石往奶黄推（R26b 实证：arcade 300m 外两道拱廊被糊成平灰）。
    color: 0x9c9384,
    // 12e-5（14 → 12，历史 38e-5）。three 的 FogExp2 是 exp(−(d·ρ)²)：
    // 400m 处 0.23%、1.5km 处 3.2%、3km 处 12.1%（旧 38e-5 分别是 2.3% / 27.7% / 72.7%）。
    // 目标：300m 外的第二道拱廊仍保留纵深感（R26b 时 14e-5 仍偏厚）。
    density: 12e-5
  },
  hemi: {
    // 逆光下正面唯一的「面光」：天空冷蓝灰 + 地面暖褐。
    // 0.42 → 0.34：环境光太足会把石头的明暗关系抬平（R26b 实证：白石整面均匀发亮、无转折）。
    // 拾回的亮度交给主光 2.2 → 2.6，即「更强的方向性、更弱的环境」。
    sky: 0x8fa0bd,
    ground: 0x6b5a48,
    intensity: 0.34
  },
  // 冷调补光（无阴影）：逆光下正面全靠它抬亮，0.35 → 0.55。
  // 再高会把「逆光」拍成正打光，所以只到 0.55。
  fill: { color: 0x9db2cf, intensity: 0.7 },
  // rim 轮廓光：换成**暖色** 0xffe2b8（对齐天空地平线暖晕），1.05 —— 逆光场景里
  // 车身边缘必须是暖亮边、暗部是冷灰，冷暖分工不能反。
  rim: { color: 0xffe2b8, intensity: 1.05 },
  softbox: [
    // 顶置长条大板（长边沿车身纵向 z）：3.6 → 1.6 → **1.1**。
    // 这块板是给车漆拉反光带的「过曝柔光箱」，但石头材质也会吃进 PMREM ——
    // gain 1.6 时白石整面被均匀洗白（R26b 实证：拱廊柱面没有转折、只剩灰白渐变）。
    // R26h 双向复测结论：1.3 对黑漆车身的可见收益 ≈ 0（profile 差值 1~2 级，属噪声量级），
    // 却让白石受光面 +0.6 级 —— 花了白石的上限预算换不到车身，按「优先保白石」退回 1.15。
    // 注意：黑漆真正的旋钮是 Adapter 里的 paintMat.envMapIntensity（0.55/0.45），不是这块板。
    { pos: [0, 95, 0], w: 40, h: 160, color: 0xfff6ee, gain: 1.15, alongZ: true },
    // 前侧补光板（车头方向）：暖白 1.15 → 0.9（同上，减少对石头的均匀洗白）
    { pos: [0, 34, 120], w: 95, h: 42, color: 0xffe4cc, gain: 0.9, alongZ: false },
    // 后侧弱补板：冷灰紫 1.15，防暗侧死黑（保留）
    { pos: [0, 30, -130], w: 80, h: 36, color: 0xd8d2e2, gain: 1.15, alongZ: false },
    // 低位暖色地面反弹板（y≈6，长边沿 z）：模拟暖石地面把光打回车底/侧裙。
    // 逆光场景里车底最容易死黑（主光从前方掠射，照不到车下），这块板是车底唯一的
    // 向上照明来源；gain 0.9（比亮白石版 1.0 略低，地面本身没被打亮）。
    { pos: [0, 6, 0], w: 200, h: 340, color: 0xe6d5c4, gain: 0.9, alongZ: true }
  ]
  // R28：paintEnvGain 死表已删（零消费，见 EnvPreset 接口注释；铁律 35 死配置零容忍）。
};

export const ENV_PRESETS: Record<string, EnvPreset> = {
  'white-cathedral': WHITE_CATHEDRAL
};

/** 当前生效的预设（Game/Renderer 只认这一个入口，切环境改这里） */
export const ACTIVE_ENV: EnvPreset = WHITE_CATHEDRAL;
