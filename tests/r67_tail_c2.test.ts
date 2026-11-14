/**
 * R67 · V800 外部高精度壳 C2 尾灯重排 —— 契约 / 数值 / 程序化贴图指纹护栏
 *
 * ⚠ **书面声明（诚实口径）**：基线 394 条护栏 **0 条读渲染后画面**；本文件同样只做
 *   数值 / 源码契约 / 程序化贴图数据指纹断言，**不测画面**。渲染判据（车尾红带
 *   bright 归零、两端竖灯可见、金色点阵凤凰可读、无横向深色开口、镀铬框与
 *   MAEXTRO 带保留）由审查线三机位目检 + 消去法 A/B 承担，不假装在 CI 里测画面。
 *
 * ⚠ **只读 git tracked**：`src/**` 源码、`src/assets/cars/v800/manifest.json`、
 *   `src/assets/cars/v800/lamp_rear.glb`（JSON chunk，Buffer 解析）、
 *   `tools/r66a_glb_probe.mjs`。**绝不读 `.qa/` / dist / 本机绝对路径 / 任何未入 git 的文件**
 *   （R64-fix 与 R67 首轮 CI 都在 ubuntu 干净 checkout 上 ENOENT 的教训：读文件前先
 *   `git ls-files` 确认入库）。
 *
 * ⚠ **禁止断言 `TEXCOORD_0` 不存在**：`lamp_rear.glb` 确有 TEXCOORD_0 accessor
 *   （10664 / VEC2 / FLOAT），只是 `materials/images/textures/samplers` 全 0、
 *   primitive.material=null ⇒ **没有任何贴图消费它**。定罪口径是「红带无贴图、
 *   纯色 emissive」，不是「无 UV」。
 *
 * 判据来源：审查线 Phase1-B 逐 mesh 消去法 A/B（hide lamp_rear ⇒ bright 100% 归零）、
 *   主理人 Phase2 综合规格、R-1/R-4 与 D 段八项裁决。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  C2_ATLAS_H,
  C2_ATLAS_W,
  C2_DC_BUDGET,
  C2_GEOM,
  C2_LAMP_SIDE_OUTSET,
  C2_COVER_FILL_DEPTH,
  C2_LAMP_SHRINK_WIDTH,
  C2_MAT_BUDGET,
  C2_PHOENIX_PANEL,
  C2_STRIP_COUNTS,
  C2_TEX_BUDGET,
  C2_TRI_BUDGET,
  buildTailLampC2,
  makeC2AtlasTexture,
  paintC2Atlas,
  phoenixMask,
  R69_C2_LAMP_ON,
  R71_C2_COVERFILL_ON,
  R71_C2_SIDE_ON,
  R82_C2_FILLDEPTH_ON,
  R82_C2_OUTSET_ON,
  remapUVToRegion,
  resolveC2StripCounts,
  type C2Painter
} from '../src/model/parts/tailLampC2';
import { R51_BAND_ON, R67_TAIL_C2_ON } from '../src/model/external/ExternalShell';

/* ───────────────── 只读 git tracked 资产 ───────────────── */
const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bin = (p: string): Buffer => readFileSync(new URL('../' + p, import.meta.url));

const shell = src('src/model/external/ExternalShell.ts');
const c2src = src('src/model/parts/tailLampC2.ts');
const adapter = src('src/model/V800Adapter.ts');
const probe = src('tools/r66a_glb_probe.mjs');
// ⚠ 不读 `tools/r49_pixel_rubric.mjs`：该文件未入 git（`git ls-files` 无此项），
//   CI ubuntu 干净 checkout 会 ENOENT（R64-fix 同款教训）⇒ 谓词改在下方内联定义。

/** GLB JSON chunk 解析（零依赖：header 12B + chunk length 4B + type 4B + JSON）。 */
function glbJson(rel: string): {
  meshes: Array<{ name?: string; primitives: Array<Record<string, unknown>> }>;
  accessors: Array<{ count: number; type: string; componentType: number }>;
  materials?: unknown[];
  images?: unknown[];
  textures?: unknown[];
  samplers?: unknown[];
} {
  const buf = bin(rel);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as ReturnType<typeof glbJson>;
}

/** 从护栏锚点切一段源码（与 r51_visual / r64_* 同源写法）。 */
const slice = (s: string, from: string, to: string): string =>
  s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

/** 只看代码、不看注释（与 tests/r51_visual.test.ts:34-35 同源）：头注释里
 *  说明性提及「TextureLoader / new URL / alphaTest」不算违规接线。 */
const codeOnly = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ═════════════════ 1. GLB / manifest 定罪契约 ═════════════════ */

describe('R67 · 红带真身资产层契约（无贴图、纯色 emissive）', () => {
  it('manifest：scale=4.75（V800，不是 R7 的 4.323）/ lamp_rear 17,485 tri', () => {
    const manifest = JSON.parse(src('src/assets/cars/v800/manifest.json')) as {
      scale: number;
      semantic: { lamp_rear: { tri: number } };
    };
    expect(manifest.scale).toBe(4.75);
    expect(manifest.semantic.lamp_rear.tri).toBe(17485);
  });

  it('lamp_rear.glb JSON chunk：单 mesh / 单 primitive / indices.count÷3=17485', () => {
    const j = glbJson('src/assets/cars/v800/lamp_rear.glb');
    expect(j.meshes).toHaveLength(1);
    expect(j.meshes[0].primitives).toHaveLength(1);
    const prim = j.meshes[0].primitives[0];
    const idx = prim.indices as number;
    expect(j.accessors[idx].count / 3).toBe(17485);
  });

  it('★ 无贴图消费：materials/images/textures/samplers 全 0、primitive.material=null', () => {
    const j = glbJson('src/assets/cars/v800/lamp_rear.glb');
    const prim = j.meshes[0].primitives[0];
    expect((j.materials ?? []).length).toBe(0);
    expect((j.images ?? []).length).toBe(0);
    expect((j.textures ?? []).length).toBe(0);
    expect((j.samplers ?? []).length).toBe(0);
    expect(prim.material ?? null).toBeNull();
  });

  it('★ TEXCOORD_0 accessor 存在（禁断言其不存在）：UV 在但无人消费', () => {
    const j = glbJson('src/assets/cars/v800/lamp_rear.glb');
    const prim = j.meshes[0].primitives[0];
    const attrs = prim.attributes as Record<string, number>;
    expect(attrs.TEXCOORD_0).toBeTypeOf('number');
    const uvAcc = j.accessors[attrs.TEXCOORD_0];
    expect(uvAcc.count).toBe(10664);
    expect(uvAcc.type).toBe('VEC2');
    expect(uvAcc.componentType).toBe(5126); // FLOAT
    expect((j.textures ?? []).length).toBe(0);
  });

  it('tools/r66a_glb_probe.mjs tri 口径已用 indices.count（不再误报 3554）', () => {
    expect(probe).toContain('p.indices != null ? json.accessors[p.indices].count : acc.count');
    expect(probe).not.toContain('const tri = (acc.count / 3) | 0;');
  });
});

/* ═════════════════ 2. 源码契约：开关 / 回滚 / 联动 / 白名单 ═════════════════ */

describe('R67 · 源码契约与逐位回滚', () => {
  it('开关默认 ON、声明后置在文件末尾、键名不含 noprewarm', () => {
    expect(R67_TAIL_C2_ON).toBe(true);
    expect(shell).toContain("export const R67_TAIL_C2_ON = !r51HookOff('r67tail');");
    // 后置：出现在 r64WriteTireBands（文件末尾函数）之后
    expect(shell.indexOf('export const R67_TAIL_C2_ON'))
      .toBeGreaterThan(shell.indexOf('export function r64WriteTireBands('));
    expect('r67tail').not.toContain('noprewarm');
  });

  it('★ #r67tail=off 加载期求值 ⇒ 开关为 false（A/B 必须各自 reload）', async () => {
    vi.stubGlobal('window', { location: { hash: '#r67tail=off' } });
    vi.resetModules();
    const mod = await import('../src/model/external/ExternalShell');
    expect(mod.R67_TAIL_C2_ON).toBe(false);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('★ =off 逐位回横带态：所有隐藏/构造/追加都在开关分支块内', () => {
    const block = slice(
      shell,
      "if (R67_TAIL_C2_ON && car === 'v800' && lampRearMat) {",
      '/* R48：R7 尾灯'
    );
    expect(block).toContain("if (m.name === 'lamp_rear') m.visible = false;");
    expect(block).toContain('buildTailLampC2({');
    expect(block).toContain('for (const mesh of c2.meshes) lampRearMeshes.push(mesh);');
    expect(block).toContain('scale: manifest.scale,'); // scale 由 manifest 读，禁写死
    // 基线：collectNamed 原行逐字保留（r48/r51/r64 护栏锚点），不在分支内重复
    expect(shell).toContain('collectNamed(lrGltf, lampRearMeshes, lampRearMat, manifest.scale);');
    expect(block).not.toContain('collectNamed(lrGltf');
    // 分支外 lampRearMeshes 仍只由 collectNamed 填充 ⇒ =off 时长度回基线 1
    expect(shell).toContain('const lampRearMeshes: THREE.Mesh[] = [];');
  });

  it('★ 旧横带不进 lampMeshes 出口（V800Adapter 零改动下绕过 setPaintShadow 的 visible 复位）', () => {
    const exportBlock = slice(shell, 'lampMeshes: [', 'lampRearMat,');
    expect(exportBlock).toContain("R67_TAIL_C2_ON && car === 'v800'");
    expect(exportBlock).toContain("lampRearMeshes.filter((m) => m.name !== 'lamp_rear')");
    expect(exportBlock).toContain(': lampRearMeshes),'); // 三元 else ⇒ =off 逐位回横带态
    // Adapter 的 setPaintShadow 仍会把全部 lampMeshes 复位 ⇒ 证明本波没改 Adapter，
    // 出口过滤是「Adapter 全文件零改动」约束下唯一稳定的隐藏手段
    expect(adapter).toContain('sm.visible = !interior;');
    // 旧横带仍留在内部数组 ⇒ dispose 账本逐位保留（D-5）
    expect(shell).toContain('for (const mesh of [...glassMeshes, ...lampRearMeshes, ...lampFrontMeshes]) {');
  });

  it('r51band 默认关（R49/R51 实验盖板不得被误开）', () => {
    expect(R51_BAND_ON).toBe(false);
    expect(shell).toContain("export const R51_BAND_ON = r51HookOn('r51band');");
  });

  it('刹车联动：红条复用 lampRearMat，V800Adapter 全文件零改动', () => {
    expect(shell).toContain('lampRearMat,');
    expect(c2src).toContain('new THREE.Mesh(stripGeo, opts.lampRearMat)');
    expect(adapter).toContain('const extRear = shellHandle?.lampRearMat;');
    // 零改动断言：Adapter 不含任何 R67 接线
    for (const needle of ['r67', 'tailLampC2', 'R67_TAIL_C2_ON', 'r67_tail_']) {
      expect(adapter).not.toContain(needle);
    }
  });

  it('R65 G4/G6 隐藏语句仍在（回退树红带不得复活）', () => {
    const block = slice(adapter, '// —— B-补：隐旧', '// —— C：前大灯');
    expect(block).toContain('/横杠|红带|宫灯|灯带场|灯笼|lantern/i');
    expect(block).toContain('mesh.visible = false;');
    expect(block).toContain('hidLegacy');
  });

  it('dispose 账本：新增材质/贴图显式释放，位置在 lampAtlasTex 之后', () => {
    expect(shell).toContain('for (const m of r67TailMats) m.dispose();');
    expect(shell).toContain('for (const t of r67TailTex) t.dispose();');
    expect(shell.indexOf('for (const m of r67TailMats) m.dispose();'))
      .toBeGreaterThan(shell.indexOf('lampAtlasTex?.dispose();'));
    // 几何随 lampRearMeshes 统一释放（既有 dispose 循环逐字保留）
    expect(shell).toContain('for (const mesh of [...glassMeshes, ...lampRearMeshes, ...lampFrontMeshes]) {');
  });

  it('R7 分支一字不动（V800 专属分支与 r7 分支并列）', () => {
    expect(shell).toContain("if (car === 'r7' && lampRearMat &&");
    expect(shell).toContain("housing.name = 'lamp_rear_housing'");
    const r7Block = slice(shell, "if (car === 'r7' && lampRearMat &&", '    }\n    if (lfGltf)');
    expect(r7Block).not.toContain('R67_TAIL_C2_ON');
    expect(r7Block).not.toContain('buildTailLampC2');
  });
});

/* ═════════════════ 3. 纯函数：条数参数化 / UV / 点阵 ═════════════════ */

describe('R67 · 条数参数化与 UV 归一', () => {
  it('默认 3 上 / 2 下（官图 + 程序化树同源）；用户「两个红色」= 上下两簇', () => {
    expect(C2_STRIP_COUNTS).toEqual({ top: 3, bottom: 2 });
    expect(c2src).toContain('上下两簇红色区');
    expect(resolveC2StripCounts('')).toEqual({ top: 3, bottom: 2 });
  });

  it('扫参钩子 #r67tailtop / #r67tailbottom 可切 2/2，且 clamp [0,6]', () => {
    expect(resolveC2StripCounts('#r67tailtop=2&r67tailbottom=2')).toEqual({ top: 2, bottom: 2 });
    expect(resolveC2StripCounts('#r67tailtop=99')).toEqual({ top: 6, bottom: 2 });
    expect(resolveC2StripCounts('#r67tailbottom=0')).toEqual({ top: 3, bottom: 0 });
  });

  it('★ remapUVToRegion 按 mesh 自身 UV bbox 归一（R4 圆角 extrude u∈[-0.5,0.5] / v∈[-0.5,1.0]）', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('uv', new THREE.Float32BufferAttribute([
      -0.5, 1.0, 0.5, 1.0, -0.5, -0.5, 0.5, -0.5
    ], 2));
    remapUVToRegion(g, 0.1, 0.4, 0.2, 0.8);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    // minU=-0.5 maxU=0.5 ⇒ 归一后 0/1 ⇒ 落 0.1 / 0.4（不是线性 remap 的 -0.4/0.6）
    expect(uv.getX(0)).toBeCloseTo(0.1, 6);
    expect(uv.getX(1)).toBeCloseTo(0.4, 6);
    expect(uv.getY(0)).toBeCloseTo(0.8, 6);
    expect(uv.getY(2)).toBeCloseTo(0.2, 6);
    // 相对比例保持（归一语义）
    expect((uv.getX(1) - uv.getX(0)) / (0.4 - 0.1)).toBeCloseTo(1, 6);
  });

  it('phoenixMask 是离散三值点阵（0/1/2），头朝左可命中、空白区熄灭', () => {
    const vals = new Set<number>();
    let lit = 0;
    for (let j = 0; j < C2_PHOENIX_PANEL.rows; j += 1) {
      for (let i = 0; i < C2_PHOENIX_PANEL.cols; i += 1) {
        const m = phoenixMask((i + 0.5) / C2_PHOENIX_PANEL.cols, (j + 0.5) / C2_PHOENIX_PANEL.rows);
        vals.add(m);
        if (m > 0) lit += 1;
      }
    }
    expect([...vals].every((v) => v === 0 || v === 1 || v === 2)).toBe(true);
    expect(lit).toBeGreaterThan(60);
    expect(lit).toBeLessThan(C2_PHOENIX_PANEL.cols * C2_PHOENIX_PANEL.rows * 0.75);
    expect(phoenixMask(0.40, 0.80)).toBe(1); // 头心（Phase 2c 强化：r 0.085，上部居中偏一侧）
    expect(phoenixMask(0.40, 0.885)).toBe(1); // 头顶羽冠横带
    expect(phoenixMask(0.99, 0.99)).toBe(0); // 屏顶右角空白
  });

  it('★ 目检修正：双翼在 22×30 点阵上左右两侧都点亮（不是单条竖直拖尾 / Y 形）', () => {
    // 竖灯特写实证：① 初版羽片半宽 0.02 < 格距 du=0.05 ⇒ 羽片几乎不命中；② atlas 半幅
    // 512×512 贴到 0.075×0.135 竖灯被纵向拉伸 1.8 倍 ⇒ 两者叠加把展翅凤凰压成竖直拖尾。
    // 此断言钉住「左右翼展可读」（mask v 大 = 屏顶 = 头/翼区）防止回归。
    let left = 0;
    let right = 0;
    for (let j = 0; j < C2_PHOENIX_PANEL.rows; j += 1) {
      for (let i = 0; i < C2_PHOENIX_PANEL.cols; i += 1) {
        const u = (i + 0.5) / C2_PHOENIX_PANEL.cols;
        const v = (j + 0.5) / C2_PHOENIX_PANEL.rows;
        if (v < 0.60) continue; // v 大 = 屏顶 = 头 / 双翼区（phoenixMask 内已做 v 翻转）
        if (phoenixMask(u, v) > 0) { if (u < 0.5) left += 1; else right += 1; }
      }
    }
    expect(left).toBeGreaterThan(8);
    expect(right).toBeGreaterThan(8);
  });

  it('★ Phase 2c：头部成形（冠+头+喙在上部独立成簇，不与翼根融合）', () => {
    // 竖灯特写实证：头/喙原先紧贴翼内缘 ⇒ 读不出独立鸟头。此断言钉住「头区点数足够」
    // （v≥0.70 的头冠+头+喙区域 ≥ 12 点）防止回归成拖尾。
    let head = 0;
    for (let j = 0; j < C2_PHOENIX_PANEL.rows; j += 1) {
      for (let i = 0; i < C2_PHOENIX_PANEL.cols; i += 1) {
        const u = (i + 0.5) / C2_PHOENIX_PANEL.cols;
        const v = 1 - (j + 0.5) / C2_PHOENIX_PANEL.rows;
        if (v < 0.70 || u < 0.20 || u > 0.65) continue; // 头/冠/喙窗口
        if (phoenixMask(u, v) > 0) head += 1;
      }
    }
    expect(head).toBeGreaterThanOrEqual(12);
  });
});

/* ═════════════════ 4. 程序化贴图数据指纹（canvas shim） ═════════════════ */

interface DrawCall {
  op: 'fill' | 'rect' | 'dot';
  color: string;
  args: number[];
}

function recordingPainter(): { p: C2Painter; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  return {
    calls,
    p: {
      fill: (w, h, color) => { calls.push({ op: 'fill', color, args: [w, h] }); },
      rect: (x, y, w, h, color) => { calls.push({ op: 'rect', color, args: [x, y, w, h] }); },
      dot: (x, y, r, color) => { calls.push({ op: 'dot', color, args: [x, y, r] }); }
    }
  };
}

describe('R67 · C2 atlas 数据指纹（零外部图片资产）', () => {
  it('★ 离散点阵、金色 fillStyle、黑烟熏底、镀铬框、无连续渐变', () => {
    const { p, calls } = recordingPainter();
    paintC2Atlas(p, C2_ATLAS_W, C2_ATLAS_H);
    const dots = calls.filter((c) => c.op === 'dot');
    const expectedDots = 2 * C2_PHOENIX_PANEL.cols * C2_PHOENIX_PANEL.rows;
    expect(dots).toHaveLength(expectedDots); // 1320 个离散点，非连续渐变
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(1);
    expect(calls[0].color).toBe('#0a0a0e');
    expect(dots.some((c) => c.color.startsWith('hsl(43,'))).toBe(true);   // 金色点亮
    expect(dots.some((c) => c.color === 'rgba(154,120,52,0.20)')).toBe(true); // 熄灭点
    expect(calls.some((c) => c.op === 'rect' && c.color === '#c2c6cd')).toBe(true); // 镀铬框
    // painter 接口本身不含渐变原语 ⇒ 录制序列里不可能出现连续渐变
    expect(calls.every((c) => !/gradient/i.test(c.color))).toBe(true);
    expect(codeOnly(c2src)).not.toContain('createLinearGradient');
  });

  it('零外部图片资产：无 TextureLoader / new URL / transparent+alphaTest', () => {
    const code = codeOnly(c2src);
    expect(code).not.toContain('TextureLoader');
    expect(code).not.toContain('new URL(');
    expect(code).not.toContain('transparent: true');
    expect(code).not.toContain('alphaTest');
    expect(code).toContain("if (typeof document === 'undefined') return null;");
  });

  it('★ vi.stubGlobal(document, canvasShim)：makeC2AtlasTexture 产出 1024×1024 CanvasTexture', () => {
    const recorded: string[] = [];
    const ctx = {
      fillStyle: '',
      fillRect: () => { recorded.push('fillRect'); },
      beginPath: () => { recorded.push('beginPath'); },
      arc: () => { recorded.push('arc'); },
      fill: () => { recorded.push('fill'); }
    };
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('canvas');
        return { width: 0, height: 0, getContext: () => ctx };
      }
    });
    const tex = makeC2AtlasTexture();
    expect(tex).toBeInstanceOf(THREE.CanvasTexture);
    expect((tex?.image as { width: number; height: number }).width).toBe(C2_ATLAS_W);
    expect((tex?.image as { width: number; height: number }).height).toBe(C2_ATLAS_H);
    expect(recorded).toContain('fillRect');
    expect(recorded).toContain('arc');
    expect(recorded.length).toBeGreaterThan(100);
    tex?.dispose();
  });
});

/* ═════════════════ 5. 几何装配 / DC·tri·材质预算实测 ═════════════════ */

describe('R67 · 三段式装配与预算（实测，不沿用旧估算）', () => {
  const scale = 4.75;

  it('★ 恒 3 mesh：盖板薄盒 12(+R71填充4) + face(4|R69侧壁8) + 红条 20；净 tri 按开关', () => {
    const lampRearMat = new THREE.MeshStandardMaterial({
      color: 0x1a0505,
      emissive: new THREE.Color(0x7a1f1a),
      emissiveIntensity: 0.35
    });
    const r = buildTailLampC2({ scale, lampRearMat });
    expect(r.meshes).toHaveLength(3);
    expect(r.budget.dc).toBe(3);
    // R69 默认：竖灯缩小 + 侧面贴完整尾灯纹理 ⇒ face 并入左右侧壁(4+4) ⇒ 40；
    // #r69c2lamp=off ⇒ 无侧壁 ⇒ 回 R68 的 36（盖板12+face4+红条20）。
    // R71：盖板侧面黑填充 +2 quad(4 tri) 并入盖板 ⇒ +4。
    const faceTri = R69_C2_LAMP_ON ? 8 : 4;
    const coverTri = R71_C2_COVERFILL_ON ? 16 : 12;
    expect(r.budget.tri).toBe(coverTri + faceTri + 20);
    expect(r.budget.mat).toBe(2);
    expect(r.budget.tex).toBe(0); // node 无 DOM ⇒ 贴图降级，不新增贴图实例
    expect(17485 - r.budget.tri).toBe(17485 - (coverTri + faceTri + 20));
  });

  it('红条 material === lampRearMat（同一实例 ⇒ brakeLevel 每帧联动）', () => {
    const lampRearMat = new THREE.MeshStandardMaterial();
    const r = buildTailLampC2({ scale, lampRearMat });
    expect(r.redStripMesh.material).toBe(lampRearMat);
  });

  it('全部新件 r44External / castShadow=false / scale 由 manifest 传入', () => {
    const lampRearMat = new THREE.MeshStandardMaterial();
    const r = buildTailLampC2({ scale: 4.75, lampRearMat });
    for (const m of r.meshes) {
      expect((m.userData as { r44External?: boolean }).r44External).toBe(true);
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(false);
      expect(m.scale.x).toBe(4.75);
    }
    expect(r.meshes.map((m) => m.name)).toEqual([
      'r67_tail_cover', 'r67_tail_c2_face', 'r67_tail_c2_strips'
    ]);
    // renderOrder：盖板 < face < 红条（逐层压在前面）
    expect(r.coverMesh.renderOrder).toBeLessThan(r.faceMesh.renderOrder);
    expect(r.faceMesh.renderOrder).toBeLessThan(r.redStripMesh.renderOrder);
  });

  it('预算常量上限、条数扫参后 tri 仍 ≤ 上限', () => {
    expect(C2_DC_BUDGET).toBe(3);
    expect(C2_TRI_BUDGET).toBe(36 + (R69_C2_LAMP_ON ? 4 : 0) + (R71_C2_COVERFILL_ON ? 4 : 0));
    expect(C2_MAT_BUDGET).toBe(2);
    expect(C2_TEX_BUDGET).toBe(1);
    const lampRearMat = new THREE.MeshStandardMaterial();
    const r = buildTailLampC2({ scale, lampRearMat, stripTop: 2, stripBottom: 2 });
    const faceTri2 = R69_C2_LAMP_ON ? 8 : 4;
    expect(r.budget.tri).toBe((R71_C2_COVERFILL_ON ? 16 : 12) + faceTri2 + (2 + 2) * 2 * 2);
    expect(r.budget.tri).toBeLessThanOrEqual(C2_TRI_BUDGET);
    expect(r.budget.dc).toBeLessThanOrEqual(C2_DC_BUDGET);
    expect(r.budget.mat).toBeLessThanOrEqual(C2_MAT_BUDGET);
    expect(r.budget.tex).toBeLessThanOrEqual(C2_TEX_BUDGET);
  });

  it('扫参到 0 上 / 0 下不崩：红条几何仍带 position 属性、tri=0', () => {
    const lampRearMat = new THREE.MeshStandardMaterial();
    const r = buildTailLampC2({ scale, lampRearMat, stripTop: 0, stripBottom: 0 });
    expect(r.redStripMesh.geometry.getAttribute('position')).toBeDefined();
    expect(r.redStripMesh.geometry.getAttribute('position').count).toBe(0);
    expect(r.budget.tri).toBe((R71_C2_COVERFILL_ON ? 16 : 12) + (R69_C2_LAMP_ON ? 8 : 4)); // 盖板薄盒 12(+R71填充4) + face(4|R69侧壁8)
    expect(r.meshes).toHaveLength(3);
  });

  it('盖板定标：宽度 clamp 在车身轮廓内、z 比 body 尾门最外层更外、不遮 MAEXTRO 带', () => {
    // 离线 GLB 探针实测：body 轮廓 1%~99% 半宽 0.20992、尾门最外层 z=-0.56751
    expect(C2_GEOM.coverHalfW).toBeLessThan(0.20992);
    expect(C2_GEOM.coverZ).toBeLessThan(-0.56751);
    expect(Math.abs(C2_GEOM.coverZ - -0.56751) * 4.75).toBeCloseTo(0.010, 3);
    expect(C2_GEOM.coverYHi).toBeLessThan(0.346); // MAEXTRO 带 yC=0.353 / h=0.014 ⇒ 下沿 0.346
    expect(C2_GEOM.coverYLo).toBeLessThan(0.2200);
    expect(C2_GEOM.coverYHi).toBeGreaterThan(0.2600);
    // 竖灯压在盖板之前（更外），红条再外凸防 z-fighting
    expect(C2_GEOM.faceZ).toBeLessThan(C2_GEOM.coverZ);
    expect(C2_GEOM.stripZ).toBeLessThan(C2_GEOM.faceZ);
  });

  it('R71 · 侧壁外扩 + 盖板侧面填充（顶点数 / z 跨度 shim 探针）', () => {
    const lampRearMat = new THREE.MeshStandardMaterial();
    const r = buildTailLampC2({ scale, lampRearMat });
    const facePos = r.faceMesh.geometry.getAttribute('position');
    const coverPos = r.coverMesh.geometry.getAttribute('position');
    if (R69_C2_LAMP_ON) {
      // 侧壁：正面左右各 1 quad(6) + 左右侧壁各 1 quad(6) = 24 顶点（mergeSafe 把 indexed
      // quad 转 non-indexed ⇒ 4 顶点扩成 6；下同）
      expect(facePos.count).toBe(24);
      // 侧壁 x 外缘比正面外缘更外凸（R82 收口 0.006→0.035，开关感知，读作「侧面竖灯比正面大」）
      if (R71_C2_SIDE_ON) {
        let maxAbsX = 0;
        for (let i = 0; i < facePos.count; i += 1) {
          maxAbsX = Math.max(maxAbsX, Math.abs(facePos.getX(i)));
        }
        const outset = R82_C2_OUTSET_ON ? 0.035 : C2_LAMP_SIDE_OUTSET;
        expect(maxAbsX).toBeCloseTo(
          C2_GEOM.lampCenterX + C2_GEOM.lampHalfW * C2_LAMP_SHRINK_WIDTH + outset, 4
        );
      }
    } else {
      expect(facePos.count).toBe(12);
    }
    if (R71_C2_COVERFILL_ON) {
      // 盖板：BoxGeometry 12 tri(36 顶点 non-indexed) + 左右填充各 4 顶点 = 44
      expect(coverPos.count).toBe(48);
      // 填充 z 从 coverZ 向内（R82 收口 0.10→0.02，开关感知）⇒ z 跨度含 [coverZ, coverZ+depth]
      let zMin = Infinity;
      let zMax = -Infinity;
      for (let i = 0; i < coverPos.count; i += 1) {
        zMin = Math.min(zMin, coverPos.getZ(i));
        zMax = Math.max(zMax, coverPos.getZ(i));
      }
      const fillDepth = R82_C2_FILLDEPTH_ON ? 0.02 : C2_COVER_FILL_DEPTH;
      expect(zMin).toBeCloseTo(C2_GEOM.coverZ, 5);
      expect(zMax).toBeCloseTo(C2_GEOM.coverZ + fillDepth, 5);
    } else {
      // off：盖板仍为 indexed BoxGeometry（24 顶点 / 12 tri），未与填充 quad 合并
      expect(coverPos.count).toBe(24);
    }
  });
});

/* ═════════════════ 6. 像素判据谓词语义（内联定义，不依赖任何未入库工具） ═════════════════ */

describe('R67 · 审查线像素判据口径同源', () => {
  it('isRedDeep / isRedBright 谓词语义可复算（内联，CI 可跑）', () => {
    const isRedDeep = (r: number, g: number, b: number): boolean =>
      r >= 70 && r > g * 1.35 && r > b * 1.35 && r - g > 25;
    const isRedBright = (r: number, g: number, b: number): boolean =>
      r >= 110 && r > g * 1.6 && r > b * 1.6;
    expect(isRedDeep(96, 36, 36)).toBe(true);      // 官图深红细带
    expect(isRedDeep(10, 10, 14)).toBe(false);     // 本波黑烟熏底
    expect(isRedBright(226, 96, 88)).toBe(true);   // R49 亮红反光条
    expect(isRedBright(10, 10, 14)).toBe(false);
  });

  it('诚实声明：本护栏不读渲染后画面，判据交审查线', () => {
    // 只钉源码存在，不读任何 png / 不调用任何 capture
    expect(c2src).toContain('三机位目检');
    expect(shell).toContain('三机位目检');
  });
});
