/**
 * R51 Phase 2-B · 视觉线回归网（源码契约 + 精确数值复算）
 *
 * 形态与 r47_runtime / r48_lamp / r49_visual / r49_perf 一致：ExternalShell.ts 顶层
 * 有 `import.meta.glob` + GLTFLoader，Node 下不直接实例化 ⇒ 钉「源码结构不变量」。
 * 主理人 §7.3「精确执行数值（直接照抄，不要自行调参）」由本文件**数值复算**锁死，
 * 防止后人把 0.45/0.55、1.15、0.90/clamp、0.9aa6b4/0.18 悄悄改掉。
 *
 * 覆盖五个子项：B1-a 压过曝 / B1-b·c 尾灯带重建 / B2 白漆 roughness /
 * B3 前灯数值降级 / B4 玻璃单次渲染。
 *
 * ⚠ 护栏单测**不建模真实遮挡/过曝**（领域铁律）：像素门 `tools/r49_pixel_rubric.mjs`
 *   与三机位目检由 Phase 3 审查线独立复跑，本文件只保证代码结构/数值不被回退。
 * ⚠ 数值门（fresh before）：WHITE 275 / 白最大连通域 132 / RED_deep 5783 /
 *   RED_bright 5738 FAIL / BEIGE_tight 740 FAIL；目标 RED_bright≤200 ∧ RED_deep≥1000 ∧ WHITE≤574。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = src('src/model/external/ExternalShell.ts');
const r7 = src('src/model/R7Adapter.ts');
const v800 = src('src/model/V800Adapter.ts');

/** 取某个函数/方法体（用于限定「不许出现」类断言的作用域，避免被注释误伤） */
const slice = (s: string, from: string, to: string): string =>
  s.slice(s.indexOf(from), s.indexOf(to));

/**
 * 「禁出现」类断言必须先剥注释：本波注释里刻意保留了历史教训关键词
 * （`alphaTest` / `onBeforeCompile` / `transmission`），不剥会把说明文字误判成代码。
 */
const codeOnly = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ═══════════════ 0. 开关真源 ═══════════════ */

describe('R51-B 开关真源（四开一关 / =off 逐位回 R50，B1-b/c 为 #r51band=on 实验启用）', () => {
  const keys = ['r51tail', 'r51band', 'r51rough', 'r51lamp', 'r51glasspass'];

  it('五个常量齐备：四开关 r51HookOff 默认开 / B1-b/c r51HookOn 默认关（单一真源）', () => {
    const offKeys = ['r51tail', 'r51rough', 'r51lamp', 'r51glasspass'];
    for (const k of offKeys) expect(shell).toContain(`r51HookOff('${k}')`);
    expect(shell).toContain('function r51HookOn(key: string): boolean');
    expect(shell).toContain("r51HookOn('r51band')");
    expect(shell).toContain('export const R51_TAIL_EI_MAX = 1.15;');
    for (const c of ['R51_TAIL_ON', 'R51_ROUGH_ON', 'R51_LAMP_ON', 'R51_GLASSPASS_ON']) {
      expect(shell).toContain(`export const ${c} = !r51HookOff(`);
    }
    /* R51 收口 · 审查线硬条件：锁死「r51band 默认关」，防下波误开实验盖板
     * （非上线形态标注 + 常量定义 + 禁回退成「默认开、=off 回滚」）。
     * `not.toContain` 只针对带函数调用的字符串，不误伤 `r51band=off` 历史注释。 */
    expect(shell).toContain("export const R51_BAND_ON = r51HookOn('r51band');");
    expect(shell).toContain('非上线形态');
    expect(shell).not.toContain("r51HookOff('r51band')");
  });

  it('Node/无 window 四开一关；#r51band=on 才启用；键名禁含 noprewarm（Game.ts:575）', () => {
    // 两个 hook 在 Node 下都 return false ⇒ !false=true（四开）、r51HookOn 直接 false（一关）
    expect(shell.match(/if \(typeof window === 'undefined'\) return false;/g)?.length)
      .toBeGreaterThanOrEqual(2);
    expect(shell).toContain('noprewarm');
    for (const k of keys) expect(k.includes('noprewarm')).toBe(false);
    // 按 key 分别期望：复算 Node 下五个常量的求值结果
    const hookOffInNode = (): boolean => false; // r51HookOff 在 Node 恒 false
    const hookOnInNode = (): boolean => false;  // r51HookOn 在 Node 恒 false
    const nodeDefaults: Record<string, boolean> = {
      r51tail: !hookOffInNode(), r51rough: !hookOffInNode(),
      r51lamp: !hookOffInNode(), r51glasspass: !hookOffInNode(),
      r51band: hookOnInNode(),
    };
    expect(nodeDefaults.r51band).toBe(false);
    for (const k of ['r51tail', 'r51rough', 'r51lamp', 'r51glasspass']) {
      expect(nodeDefaults[k]).toBe(true);
    }
    // 「#r51band=on 才启用」：源码正则契约 + 纯函数复算（=off / 裸键 / 空 hash 均不启用）
    expect(shell).toContain('function r51HookOn(key: string): boolean {');
    expect(shell).toMatch(/function r51HookOn\(key: string\): boolean \{[\s\S]{0,240}\$\{key\}=on/);
    const bandOn = (hash: string): boolean => /(?:^|[#&])r51band=on/i.test(hash);
    expect(bandOn('#r51band=on')).toBe(true);
    expect(bandOn('#r51band=on&r51tail=off')).toBe(true);
    expect(bandOn('')).toBe(false);              // 默认关
    expect(bandOn('#r51band=off')).toBe(false);  // =off 不启用
    expect(bandOn('#r51band')).toBe(false);      // 裸键不启用
  });

  it('两个 Adapter 从 ExternalShell import 开关，不在 config/** 另起真源', () => {
    for (const a of [r7, v800]) {
      expect(a).toContain('R51_LAMP_ON,');
      expect(a).toContain('R51_TAIL_EI_MAX,');
      expect(a).toContain('R51_TAIL_ON,');
      expect(a).toContain("} from './external/ExternalShell';");
    }
  });
});

/* ═══════════════ B1-a 压亮灯态过曝 ═══════════════ */

describe('R51-B1-a 压过曝（只改数值/上限，不改联动链与 brakeLevel 初值）', () => {
  it('ExternalShell：荧光红 0xff1e14 → 官图深红 0x7a1f1a，off 分支逐位保留', () => {
    expect(shell).toContain('emissive: new THREE.Color(R51_TAIL_ON ? 0x7a1f1a : 0xff1e14)');
    expect(shell).toContain('禁荧光红');
  });

  it('两 Adapter：ei 经 clamp ≤1.15，且待机系数按深红反推 0.16+0.34·L', () => {
    expect(r7).toContain('0.16 + (brakeLevel + snapT * SNAP_GAIN * 0.12) * 0.34');
    expect(v800).toContain('0.16 + (brakeLevel + snapGain * 0.12) * 0.34');
    for (const a of [r7, v800]) {
      expect(a).toContain('R51_TAIL_EI_MAX');
      expect(a).toContain('if (R51_TAIL_ON) {');
      // 原 R48/R47 公式字符串逐字保留在上方（覆盖写结构），`#r51tail=off` 不进覆盖分支
      expect(a).toContain('R48_LAMP_TONE\n          ? 0.30 + (brakeLevel');
    }
    /* 审查线 P0：clamp 必须覆盖「整个三元」的所有分支 —— 不能只压 R48 待机分支
     * 而让亮灯/刹车态（brakeLevel→8）从 R47 分支复发过曝；snap 周期项亦须在内。
     * 本实现是「R51 开启时以 min(0.16+…*0.34, 1.15) **完全覆盖**原三元结果」：
     * 原三元无论走 R48 还是 R47 分支都不参与最终值 ⇒ clamp 对全部输入生效
     * （比把 clamp 包在三元最外层更强：连另一分支的系数都被换掉）。 */
    for (const [a, snapExpr] of [
      [r7, 'snapT * SNAP_GAIN * 0.12'],
      [v800, 'snapGain * 0.12']
    ] as const) {
      const origIdx = a.indexOf('R48_LAMP_TONE\n          ? 0.30 + (brakeLevel');
      const coverIdx = a.indexOf('if (R51_TAIL_ON) {');
      expect(origIdx).toBeGreaterThan(-1);
      expect(coverIdx).toBeGreaterThan(origIdx); // 覆盖写在原公式之后
      const block = a.slice(coverIdx, coverIdx + 420);
      expect(block).toContain('Math.min(');
      expect(block).toContain('R51_TAIL_EI_MAX');
      expect(block).toContain(snapExpr); // snap 爆闪周期项也在 clamp 内
    }
    // R47 亮灯分支原公式保留（`#r51tail=off` 逐位回滚，含 brakeLevel→8 的亮灯路径）
    expect(r7).toContain('(R7_TAIL_STANDBY_EI * (BRAKE_BASE_INTENSITY + brakeLevel)) /');
    expect(v800).toContain(': 0.35 + (brakeLevel + snapGain) * 2.2; // R47 原状');
  });

  it('brakeLevel 初值 / damp k / 联动链结构一律不动（物理玩法契约）', () => {
    expect(r7).toContain('const R7_TAIL_STANDBY_LEVEL = 0.7;');
    expect(r7).toContain('const R7_TAIL_STANDBY_EI = 2.6;');
    expect(r7).toContain('let brakeLevel = R7_TAIL_STANDBY_LEVEL;');
    expect(r7).toContain('damp(brakeLevel, brakeTarget, BRAKE_FADE_K, dt)');
    expect(v800).toContain('const TAIL_BASE = 2.6;');
    expect(v800).toContain('let brakeLevel = TAIL_BASE;');
    expect(v800).toContain('damp(brakeLevel, brakeTarget, 18, dt)');
  });

  it('精确数值复算：R7 待机 0.398 / V800 待机 1.044 / 亮灯钳到 1.15', () => {
    const ei = (level: number, snap = 0): number =>
      Math.min(0.16 + (level + snap * 0.12) * 0.34, 1.15);
    expect(ei(0.7)).toBeCloseTo(0.398, 3); // R7_TAIL_STANDBY_LEVEL
    expect(ei(2.6)).toBeCloseTo(1.044, 3); // V800 TAIL_BASE
    expect(ei(8)).toBe(1.15); // Game.setBrakeLights(8) 亮灯/刹车态
    expect(ei(8, 10)).toBe(1.15); // snap 爆闪也不得上穿
    // 旧值（回退基线）确实更亮，证明压缩方向正确
    expect(0.30 + 0.7 * 0.85).toBeCloseTo(0.895, 3);
    expect(0.30 + 8 * 0.85).toBeCloseTo(7.1, 3);
  });
});

/* ═══════════════ B1-b/c 尾灯带重建 ═══════════════ */

describe('R51-B1-b/c 尾灯带（深红 atlas + 盖板收窄 + 零新增 DC）', () => {
  const atlas = slice(shell, 'function makeR7RearBandAtlas(', '/**\n * R49-P2b · R7 下缘红反光条 atlas');

  it('atlas 双分支：r51=true 新绘制 / false 逐位保留 R49 原绘制', () => {
    expect(atlas).toContain('function makeR7RearBandAtlas()');
    expect(atlas).toContain('const r51 = R51_BAND_ON;'); // 开关在函数内读，保持无参签名
    expect(atlas).toContain('if (r51) {');
    expect(atlas).toContain('} else {');
    expect(atlas).toContain('R49 原绘制分支结束');
    // 旧分支仍在（深墨底板 / 白细条 / LUXEED）
    expect(atlas).toContain("g.fillStyle = '#14141a';");
    expect(atlas).toContain("g.fillText('L U X E E D', W / 2, yRow(1.015));");
  });

  it('新 atlas 用官图深红 #5A1E1E~#6a2020，含白红白/字标/下缘反光条，全同图不透明', () => {
    expect(atlas).toContain("g.fillStyle = '#5A1E1E';");
    expect(atlas).toContain("g.fillStyle = '#6a2020';");
    expect(atlas).toContain("g.fillStyle = '#6a1d1d';"); // 下缘红反光条
    expect(atlas).toContain("g.fillStyle = '#d8d4cc';"); // 白
    expect(atlas).toContain("g.fillStyle = '#8c2420';"); // 红
    expect(atlas).toContain("g.fillText('L U X E E D'");
    // 禁荧光红：新分支不得出现 ff1e14
    expect(atlas).not.toContain('0xff1e14');
    // R49 教训：不新增独立 transparent/alphaTest 反光条 mesh；
    // 下缘反光条与底板共用同一张不透明画布（整张 fillRect 无透明底）
    expect(codeOnly(atlas)).not.toContain('alphaTest');
    expect(codeOnly(atlas)).toContain('g.fillRect(0, 0, W, H);');
  });

  it('盖板：r49Hole 启用、收窄 ×0.90 clamp[1.70,1.86]、z=bodyMaxZ+0.010', () => {
    const cover = slice(shell, 'const r51Band = R51_BAND_ON;', '/* ④ 下缘红反光条');
    // R51 把「默认启用」并入 r49Hole 布尔，所有 `r49Hole ?` 参数字符串逐字保留
    expect(shell).toContain(') || R51_BAND_ON;');
    expect(cover).toContain('const r51Band = R51_BAND_ON;');
    expect(cover).toContain('Math.min(1.86, Math.max(1.70, 2.02 * 0.90)) / 2.02');
    expect(cover).toContain('-(bodyMaxZ + 0.010)');
    expect(cover).toContain('makeR7RearBandAtlas() ?? undefined'); // 无参签名（历史契约）
    // 尺寸与压暗三件套按 §7.3 精确保留
    expect(cover).toContain('coverH = r49Hole ? 0.34 : 0.20');
    expect(cover).toContain('roughness: r49Hole ? 0.70 : 0.5');
    expect(cover).toContain('metalness: r49Hole ? 0.06 : 0.1');
    expect(cover).toContain('envMapIntensity: r49Hole ? 0.45 : 1');
    // `#r49hole=on` 旧钩子语义保留（定义行在 cover slice 起点之前，全文检查）
    expect(shell).toContain('const r49Hole = /(?:^|[#&])r49hole=on/i.test(');
    // 几何拓扑不变：仍是 housing + band 两块 mesh
    expect(cover).toContain("housing.name = 'lamp_rear_housing'");
    expect(cover).toContain("band.name = 'lamp_rear_band'");
  });

  it('精确数值复算：2.02×0.90=1.818 落在 clamp 内，缩放系数 0.9', () => {
    const width = Math.min(1.86, Math.max(1.70, 2.02 * 0.90));
    expect(width).toBeCloseTo(1.818, 3);
    expect(width / 2.02).toBeCloseTo(0.9, 6);
    expect(width).toBeGreaterThanOrEqual(1.70);
    expect(width).toBeLessThanOrEqual(1.86);
  });

  it('#r51band=off ⇒ r49Hole=false 逐位回 R48/R50（盖板被遮挡态）', () => {
    const cover = slice(shell, 'const r51Band = R51_BAND_ON;', '/* ④ 下缘红反光条');
    expect(cover).toContain("r51Band = R51_BAND_ON;");
    expect(cover).toContain(': -2.505');
    expect(cover).toContain(': 0.240 * s');
    expect(cover).toContain(': lampRearMat');
  });
});

/* ═══════════════ B2 V800 白漆镜面铬 ═══════════════ */

describe('R51-B2 V800 白漆 roughness 全局一档（禁按车分支、禁改资产）', () => {
  const rough = slice(shell, 'if (R51_ROUGH_ON) {', 'const bodyMesh = bodyFound;');

  it('onBeforeCompile 注入 roughnessFactor 一档映射，零额外贴图/显存', () => {
    expect(rough).toContain('material.onBeforeCompile = (shader) => {');
    expect(rough).toContain("'#include <roughnessmap_fragment>'");
    expect(rough).toContain('roughnessFactor = 0.45 + 0.55 * roughnessFactor;');
    expect(rough).not.toContain('new THREE.CanvasTexture');
    expect(rough).not.toContain('setRenderTarget');
  });

  it('全局一档：源码不含按 car 分支（v800/r7 同一公式）', () => {
    expect(rough).not.toContain("car === 'v800'");
    expect(rough).not.toContain("car === 'r7'");
    expect(rough).toContain('no per-car branch');
  });

  it('不动 mr.png / basecolor 资产，roughnessMap 仍取 G 通道', () => {
    expect(shell).toContain('roughnessMap: mrTex, // G 通道');
    expect(shell).toContain('metalnessMap: mrTex, // B 通道');
    expect(shell).toContain('roughness: 1,');
  });

  it('精确数值复算：v800 中位 0.224→0.573，r7 0.890→0.940（几乎不动）', () => {
    const band = (g: number): number => 0.45 + 0.55 * g;
    expect(band(0.224)).toBeCloseTo(0.573, 3);
    expect(band(0.890)).toBeCloseTo(0.940, 3);
    expect(band(0.45)).toBeCloseTo(0.6975, 4);
    // 单调且不产生硬折点（区别于 max(0.45, g)）
    expect(band(0.1)).toBeLessThan(band(0.5));
    expect(band(0.5)).toBeLessThan(band(0.9));
  });
});

/* ═══════════════ B3 前灯数值降级 ═══════════════ */

describe('R51-B3 前灯 H5 运行时快修（只做数值，零 UV 依赖）', () => {
  it('ExternalShell：emissive 0xcfe0ff→0x9aa6b4，强度 0.7→0.18，off 分支保留', () => {
    expect(shell).toContain('new THREE.Color(R51_LAMP_ON ? 0x9aa6b4 : 0xcfe0ff)');
    expect(shell).toContain('emissiveIntensity: R51_LAMP_ON ? 0.18 : 0.7');
  });

  it('两 Adapter 联动同步降级（构造初值会被每帧覆盖，只改初值无效）', () => {
    expect(r7).toContain('0.10 + (headLevel / Math.max(headBaseIntensity, 1e-3)) * 0.08');
    expect(r7).toContain('0.12 + (headLevel / Math.max(headBaseIntensity, 1e-3)) * 0.78');
    expect(v800).toContain('0.10 + (headLevel / HEAD_BASE) * 0.08');
    expect(v800).toContain('0.12 + (headLevel / HEAD_BASE) * 0.78');
  });

  it('禁做 onBeforeCompile / 深度灯语结构（R46 atlas 错位黑腔教训）', () => {
    const front = slice(shell, 'lampFrontMat = new THREE.MeshStandardMaterial', 'collectNamed(lfGltf');
    expect(codeOnly(front)).not.toContain('onBeforeCompile');
    expect(front).not.toContain('DataTexture');
    // atlas 缺失降级路径原样保留
    expect(front).toContain('hasLampMap = lampAtlasTex != null && !lampMapDisabled()');
  });
});

/* ═══════════════ B4 玻璃单次渲染 ═══════════════ */

describe('R51-B4 玻璃 forceSinglePass（性能 + 清每帧 side 脏标记）', () => {
  const glass = slice(shell, 'const glassMat = new THREE.MeshPhysicalMaterial', '// QA：#r44glass=');

  it('glassMat.forceSinglePass 由开关控制；transparent/DoubleSide/depthWrite 逐位不动', () => {
    expect(glass).toContain('glassMat.forceSinglePass = R51_GLASSPASS_ON;');
    expect(glass).toContain('transparent: true,');
    expect(glass).toContain('side: THREE.DoubleSide,');
    expect(glass).toContain('depthWrite: false');
    expect(glass).toContain('WebGLRenderer.js:1364');
    expect(glass).toContain('187,838');
  });

  it('不回 transmission（R12 铁律⑤），不改 opacity 语义', () => {
    expect(codeOnly(glass)).not.toContain('transmission');
    expect(glass).toContain('opacity: 0.55,');
    expect(shell).toContain('setGlassOpaque(opaque: boolean)');
  });
});

/* ═══════════════ 契约不触碰 ═══════════════ */

describe('R51-B 白名单/历史契约不触碰', () => {
  it('几何剔除 / 装配 / roof-cull 一律未动（Adapter 只改 emissive 公式）', () => {
    for (const a of [r7, v800]) {
      expect(a).toContain('buildShadowProxies(root)');
      expect(a).toContain('loadExternalShell(');
      expect(a).toContain('batchMergeStatic(');
    }
    expect(r7).toContain('r50roof=off');
    expect(v800).toContain('mergeSafe(');
  });

  it('Phase 2-A 冻结区不被 import（config/r51Perf、Game、fx 均未被本波改动引用）', () => {
    for (const a of [r7, v800, shell]) {
      expect(a).not.toContain("config/r51Perf");
      expect(a).not.toContain("core/Game");
    }
  });
});
