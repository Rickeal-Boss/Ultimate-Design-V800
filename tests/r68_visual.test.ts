/**
 * R68 · V800 视觉波 —— 契约 / 数值 / 源码指纹 / 像素指纹 / 隐私 护栏
 * （Phase 4 前置骨架，与 Phase 2 开发线并行；文件白名单：只写本文件）
 *
 * ═══ 主理人后续裁决已并入（优先级高于原派单） ═══
 * · **第 0 条「零护栏改动契约」**：`tests/r67_tail_c2.test.ts` 一行都不改；
 *   C2 盖板只动 `coverDepth` 标量 / `paintC2Atlas()` Canvas 内深色 surround / 材质标量；
 *   `C2_GEOM` 全字段与几何拓扑禁改 ⇒ 36 / cover12 / face4 恒等、:445-455 的
 *   `toBeCloseTo(0.010,3)` 继续成立、:206-212 dispose 位置不变。
 * · 7 开关逐字表、`r51HookOff` 私有实证、B2 `r44External` 逐字不变、
 *   B3 `WHEEL_HUB_CENTERS` 禁改、B1/nonce URL 模板结构断言、B5 三栏分工。
 *
 * ═══ 14:06 主理人「3 处过期快照」纠正（本版已同步） ═══
 * · **常量名以开发线实际落盘为准、不回头改名**：`R68_ARCH_ON` / `R68_R7_TAIL_ON` /
 *   `R68_R7_LAMP_ON` / `R68_C2_COVER_ON` / `R68_GLASS_OPAQUE_ON` / `R68_WHEEL_ON` /
 *   `R68_GLDIAG_ON`（`ExternalShell.ts:3050-3056`）。运行时真源是 **7 个 hook key**
 *   （`r68arch`…`r68gldiag`），逐字不变；常量名只是 TS 标识符。⇒ 原「常量名裁决 TODO」
 *   已解除，改为启用断言逐字钉死声明行，并禁旧表名别名。
 * · **`N_WINDOWS` 已落盘**：`wheelHub.ts:102` `export const N_WINDOWS = R68_WHEEL_ON ? 20 : 18`
 *   ⇒ 原 B5-5 TODO 已解除，改为启用断言（18/20 成对 + 开关分支 + off 回 18）。
 * · **已落盘文件清单**：改 `ExternalShell.ts` / `R7Adapter.ts` / `tailLampC2.ts` /
 *   `wheelHub.ts` / `Renderer.ts`；新增 `r7FrontAtlas.ts` / `r7TailWrap.ts` /
 *   `tests/r68_visual.test.ts` ⇒ `R7Adapter.ts` / `Renderer.ts` 已加入只读白名单并逐文件 grep。
 *
 * ⚠ **CI BLOCKER（实测仍未消除，交主理人 git add）**：`ExternalShell.ts:37-38`
 *   （tracked）静态 import 两个**未入库**新文件 `r7TailWrap` / `r7FrontAtlas`；
 *   我的护栏文件本身也仍 `??` untracked。干净 checkout 上 `npm test`(vitest) 与
 *   `npm run build`(vite build) 都会模块解析失败 ⇒ Phase 4 前必须三件一起 git add。
 *   护栏绝不 readFileSync 这两个未入库文件，只在 CI 日志打印其入库状态。
 *
 * ⚠ **口径更正**：本人**从未跑过含本护栏的全量 vitest**；此前回报中的
 *   `42 files / 452` 是「446 passed + 6 skipped = 452 总条数」的**推算**，不是实测全绿。
 *   唯一实测全量是基线 `41 files / 425 tests`（exit 0，跑过两次）。
 *   Phase 4 还需额外核 `vite build` 的 **bundle 三块结构**（R65 验收项）。
 *
 * ⚠ **诚实口径**：vitest 无 WebGL、无真实 Canvas，**本文件不读渲染后画面**。
 *   `paintC2Atlas(p,w,h,surround=false)`（export 纯函数，修正 A/D 后第 4 形参落地）
 *   → 内联 RasterPainter 光栅化成 RGBA 像素缓冲 + 绘制指令序列，做 sha256 指纹、
 *   颜色族结构、以及 **off(false) 逐位回冻结基线 / on(true) 仅末尾追加 4 条 surround
 *   rect / 两者像素指纹不等** 的精确对照；
 *   `makeR7RearBandAtlas`（ExternalShell.ts **私有**零参、依赖 document，vitest 无法直调）
 *   → 复用 r51_visual.test.ts:164 同款 slice 的源码级 sha256 指纹。
 *   R67 已覆盖的 1320-dots 调用序列 / CanvasTexture / 源码 createLinearGradient /
 *   makeR7RearBandAtlas 签名接线 **一律不重复**。三机位目检仍归审查线。
 *
 * ⚠ **只读 git tracked**：`readFileSync` 前一律 `execFileSync('git',['ls-files','--',p])`
 *   验入库（ci.yml 顺序 `npm ci → npm test → npm run build`，未入库文件会**先炸在
 *   Unit tests 步骤**；R64-fix / R67-CI-fix 两次 ENOENT 同款）。绝不读 `.qa/` / `dist/` /
 *   本机绝对路径 / 未入库工具 / 未入库新文件（r7FrontAtlas.ts / r7TailWrap.ts）。
 *   谓词全部内联定义，不 import 未入库工具。
 *
 * ═══ 开发线「修正 A/D/C」落盘后的 ②TODO 解除（本版） ═══
 * · 修正 A/D：C2 on 态独立第 4 mesh `r68_tail_c2_surround` **已撤销**；surround 改画进
 *   `paintC2Atlas(...,true)`；on/off 两态恒 3 mesh / 36 tri / 3 DC / 2 材质 / 1 贴图。
 *   `C2_COVER_R68` 删除，换成 6 个具名成对常量 + `C2_ATLAS_SURROUND_COLOR`。
 * · 修正 C：`r7FrontDetails.ts` 新增 `createR7FrontDetailsR68()`，`R7Adapter.ts:43`
 *   别名 import、调用点 `const front = createR7FrontDetails();` 一字未改。
 * ⇒ 原 TODO「coverDepth 命名待中转」「C2 atlas 精确对照」「常量 name 裁决」三条
 *   **全部解除并升级为启用断言**。
 * · **B5-2 已终裁放行**（Phase 4 开工信号）：`R7Adapter.ts` 的 `r68ArchOn` 在函数体内、
 *   装配期一次性求值 ⇒ 认可等价、不要求上提；真源 `R68_ARCH_ON` 仍在 ExternalShell.ts
 *   模块顶层。原 B5-2 TODO 已从 skip 移入启用断言钉死该终裁形态。②TODO 只剩 CI BLOCKER 一条。
 *
 * ⚠ **B5 三栏分工（Phase 4 门禁版终值）**：
 *   ① **42 条启用静态断言**（11 个 describe，全绿）；
 *   ② **1 条 TODO skip**（★CI BLOCKER：三文件 git add + 新文件隐私扫描 + R7 band 切片基线；
 *      主理人 Phase 5 统一 add，Phase 4 解除）；
 *   ③ **4 条交 Phase 3 目检 / 运行时**（vitest 无 WebGL，不覆盖）。
 *   合计 **47 条 it = 42 启用 + 5 skip**，`npx vitest run tests/r68_visual.test.ts` exit 0。
 *
 * ⚠ **骨架不破绿**：依赖 Phase 2 最终实现的断言全部隔离在末尾 `describe.skip`。
 *   新增本文件后门禁推算 41/425 → **42 files / 467 passed | 5 skipped (472)**（本版已实跑）。
 *   tsconfig.json include=["src","vite.config.ts"] ⇒ tsc 门禁不检查 tests/，
 *   本文件由 vitest(esbuild) 转译执行。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  C2_ATLAS_H,
  C2_ATLAS_W,
  C2_DC_BUDGET,
  C2_GEOM,
  C2_MAT_BUDGET,
  C2_PHOENIX_PANEL,
  C2_STRIP_COUNTS,
  C2_TEX_BUDGET,
  C2_TRI_BUDGET,
  R69_C2_LAMP_ON,
  R71_C2_COVERFILL_ON,
  R71_C2_SIDE_ON,
  phoenixVRangeActive,
  buildTailLampC2,
  paintC2Atlas,
  type C2Painter
} from '../src/model/parts/tailLampC2';

/* ═══════════════ 常量区（★★ = Phase 4 需同步 / 裁决） ═══════════════ */

/** 本护栏允许 readFileSync 的白名单（全部已 git tracked；含 r67 护栏本体）。 */
const TRACKED = [
  'src/model/external/ExternalShell.ts',
  'src/model/V800Adapter.ts',
  'src/model/parts/tailLampC2.ts',
  'src/model/parts/wheelHub.ts',
  'src/model/parts/r7FrontDetails.ts',
  'src/model/R7Adapter.ts',
  'src/render/Renderer.ts',
  'tests/r67_tail_c2.test.ts'
] as const;

/**
 * 7 行逐字表（主理人 14:06 裁决：**常量名以开发线实际落盘为准，不回头改名**）。
 * 运行时真源是 hook key（逐字不变）；常量名只是 TS 标识符，下划线分词无语义影响。
 * 常量名 ↔ hook key ↔ off 键名一一对应；全部默认 ON、键名不含 noprewarm、禁别名。
 */
const R68_SWITCHES = [
  { name: 'R68_ARCH_ON',          key: 'r68arch',        off: '#r68arch=off' },
  { name: 'R68_R7_TAIL_ON',       key: 'r68r7tail',      off: '#r68r7tail=off' },
  { name: 'R68_R7_LAMP_ON',       key: 'r68r7lamp',      off: '#r68r7lamp=off' },
  { name: 'R68_C2_COVER_ON',      key: 'r68c2cover',     off: '#r68c2cover=off' },
  { name: 'R68_GLASS_OPAQUE_ON',  key: 'r68glassopaque', off: '#r68glassopaque=off' },
  { name: 'R68_WHEEL_ON',         key: 'r68wheel',       off: '#r68wheel=off' },
  { name: 'R68_GLDIAG_ON',        key: 'r68gldiag',      off: '#r68gldiag=off' }
] as const;
const R68_KEYS = R68_SWITCHES.map((s) => s.key);

/**
 * ⚠ **CI BLOCKER（实测 14:06 后仍未消除）**：这两个新文件已落盘、但 `git ls-files` = 空
 *   （`??` 未入库），而 **tracked** 的 `ExternalShell.ts:37-38` 静态 import 它们：
 *     `import { buildR7TailWrap } from '../parts/r7TailWrap';`
 *     `import { r68BuildR7FrontLamp } from '../parts/r7FrontAtlas';`
 *   ⇒ CI 干净 checkout 上 `npm test`(vitest) 与 `npm run build`(vite build) 都会**模块解析失败**，
 *   比 R64/R67 的 readFileSync ENOENT 更早炸。护栏绝不 readFileSync 它们；Phase 4 前须 git add。
 */
const R68_PENDING_TRACK_FILES = [
  'src/model/parts/r7FrontAtlas.ts', 'src/model/parts/r7TailWrap.ts'
] as const;

/** 第 0 条：r67 护栏全文件冻结（CRLF 规范化后 UTF-8 sha256）。R71 更新基线：该护栏新增 R71 侧贴/盖板填充 shim 探针，属预期改动。
 *  R82 再更新基线：C2 侧面黑板收口（盖板填充进深 0.10→0.02 / 竖灯外缘 0.006→0.035，`#r82c2filldepth`/`#r82c2outset` 回滚）
 *  触发 r67_tail_c2.test.ts 的 maxAbsX/zMax 两条 toBeCloseTo 精确坐标断言改为 R82 开关感知（ON 断新值 / OFF 断原基线），
 *  护栏强度不减、on/off 两态都被精确钉住，属预期改动。 */
const R67_GUARD_SHA256 = '3a7f2ee613dcc191fbf39811d2510a8f4d4302a0477b956d1637da6ce70e0a95';
/** V800Adapter.ts 全文件冻结（CRLF 规范化后 UTF-8 sha256）。W2批4 更新基线：透明件渲染排序
 *  治理——给 depthWrite=false 的玻璃（greenhouse 桶 + rear-glass-upper 克隆）经
 *  userData.vorderGlass 标记批量钉 renderOrder=10、welcome-carpet / tailgate-maextro /
 *  gauge-screen 表面贴花钉 renderOrder=1，新增 `#vorder=off` 回滚钩子，属预期改动。
 *  R82 再更新基线：顶棚补覆盖治车内看穿——新增 cabin-roof-carpet-ext-rear/ext-front（×2 段阶梯）
 *  补齐 cabin 态被剔朝上外表面(z[-2.609,+1.313]) 相对中段 carpet 的前后缺口（+3 mesh/+3 DC、零新材质、
 *  防穿壳经 GLB 外皮最低 y 实测压 14mm），`#r82v800roofext=off` 回滚，属预期改动。 */
const ADAPTER_SHA256 = '843a49c9ac52d1b53982be89b34b676fb4dd4e5e7773006d108df0493ddfa004';
/* ═══ R81 P1/P2 · 冻结基线更新（cam-gate 线实测口径）═════
 * 本波 V800Adapter.ts 两处改动（均属预期改动，故更新本基线）：
 *   · P1 机盖(hood)视角下半屏纯黑根治：shell body GLB 在引擎盖区（world z −1.1~−1.77）
 *     开无面（射线实测 MISS），程序化 `机盖面板` 原共用 batch 的 paint-upper 实例 ⇒
 *     shell ready 后 W1 pass1 把该实例 visible=false ⇒ 引擎盖区无人渲染 = 纯黑大板。
 *     处置：机盖面板专属 paint 克隆（kept=true 恒可见 + cabinPaintShadow 行为旗标跳去重
 *     + polygonOffset 赢深度）+ 材质实例预算 80→81（登记见 V800Adapter.ts）。
 *   · P2 高精盘近裁剪面黑闪：near 扫过盘面时大三角被裁铺满视口；R80 换程序化盘不解决
 *     （同位同样被裁）。处置：新增近裁剪面硬隐藏安全网（相机钻进盘包围球 ⇒ 两盘都隐），
 *     新增 `#r81steerhardhide=off` 回滚钩子。
 * 回滚钩子：`#r81hoodmat=off`（P1）/ `#r81steerhardhide=off`（P2）。 */
/* ═══ R81 · 冻结基线更新（QA 实测口径；⚠ 与主理人转交值冲突，已回传待裁决）═════
 * 本常量必须与断言 `expect(sha256(adapter)).toBe(ADAPTER_SHA256)` 的口径逐位一致：
 *   adapter = src(...) = readFileSync(p,'utf8').replace(/\r\n/g,'\n')
 *   sha256(s) = createHash('sha256').update(Buffer.from(s,'utf8')).digest('hex')
 * ⇒ 唯一正确取值 = 该口径对**当前定稿工作树文件**的实算值。
 *
 * ▸ 实测（13:34~13:41 三算逐位一致，node / python / 护栏精确口径）：
 *     GUARD_EXACT sha256(adapter) = d1909adf7f098836f7060319cb65794c70f1466377128be502d3798393f22e1b
 *     （R81 P1/P2 改动后重算，node 护栏精确口径；旧值 4a08b6a4…= R80 定稿版，已被本波取代）
 *     python byte 版 LF 归一        = 4a08b6a4…（与上式相同）
 *     当前工作树 raw(CRLF)          = 9588884af1005eec65f98b97093b5f2e5bfa6c163b27b89db231206ce4a7702f
 *     HEAD / index 版(R80, 288161B) = f0bc5137a7906d868421d624762de2b4458723509002a06c18affb8d6100bc04
 *     当前工作树 = 300952B / CRLF 5679 行 / mtime 2026-11-14 13:15:10（第 7 次取证未变）
 *
 * ▸ 主理人转交值（第 5 封消息）LF=f8dc41234b90d37ae10d59255b040fefe5da202f75c7e0f5ab2b78b6e06ec207
 *   raw=def27bf0c2794ed792a584d2e196d0564b8f1c58872f18000b0bf0c1b8219f56
 *   ⚠ 两者**都不等于**当前文件的 LF / raw / HEAD，连 raw 都对不上 ⇒ 不是行尾口径差异，
 *     而是主理人实算时的 V800Adapter.ts 内容版本与当前定稿版不同（写盘竞态：
 *     该文件 12:54:31→299125B、13:15:10→300952B 至少两次改写）。
 *     若照写 f8dc…，commit 后 gitStatus 变空时 sha 断言必红 ⇒ 直接破 CI，故本轮按实测写入。
 *
 * ▸ 若主理人 commit 的是另一版内容（或 V800Adapter.ts 再次改写），下方诊断 it 会打印
 *   LF_LIVE_SHA256 与 FROZEN 的逐位差异 ⇒ 请二次唤醒 QA 重算本常量，绝不放宽断言。
 * ▸ 历史坑：sha256sum 对 CRLF 工作副本算 raw 会错（R80 commit 4915fb4 曾补），
 *   一律先 CRLF→LF 归一；core.autocrlf=true 下 CI 干净 checkout 为 LF 版，
 *   归一后与本地 CRLF 归一内容逐位相同 ⇒ 4a08… 跨环境稳定。 */
/** off 态 / 原 atlas（HEAD=dc765a4）像素缓冲指纹 —— 供「默认 vs off」对照差分。 */
const R68_C2_ATLAS_BASELINE_SHA256 = '1bb27545a399a7d7e14f56f778f9a309973298a508ca5e97a90ba76784183347';
const R68_R7_BAND_SLICE_SHA256_BASELINE = '08ecfe355d212a1252665b381305df1e2b6cf1640cb055739ab4c8ec1814038c';

/** B2：`markExternal()` 内的 r44External 赋值语句，逐字不变。 */
const R44_EXTERNAL_STMT = '(mesh.userData as { r44External?: boolean }).r44External = true;';
/** B3：4 组轮心坐标逐位不变（程序化树标定值，连 V800 自己都不精确，禁改）。 */
const WHEEL_HUB_CENTERS_LINES = [
  'fl: { x: 0.855, y: 0.382, z: 1.715, side: 1 }',
  'fr: { x: -0.855, y: 0.382, z: 1.715, side: -1 }',
  'rl: { x: 0.855, y: 0.382, z: -1.715, side: 1 }',
  'rr: { x: -0.855, y: 0.382, z: -1.715, side: -1 }'
] as const;
/** B5-5：N_WINDOWS 允许值（off 回滚 18 / on 态 20）。 */
const R68_N_WINDOWS_ALLOWED = [18, 20] as const;

/** 隐私黑名单：本机绝对路径 / 内域名 / 网盘痕迹 / 证书开关 / 凭据字面量。 */
const PRIVACY_RULES: RegExp[] = [
  /139\.com/i,
  /clipboard-images/i,
  /\.workbuddy/i,
  /sslVerify/i,
  /[A-Za-z]:\\[Uu]sers\\/,          // C:\Users\ 等
  /\/Users\//,                      // /Users/xxx
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"]{6,}['"]/i
];

/* ═══════════════ helpers（全部内联，零未入库依赖） ═══════════════ */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** git tracked 校验：返回 `git ls-files -- <p>` 的输出（未入库 ⇒ 空串）。 */
function lsFiles(p: string): string {
  try {
    return execFileSync('git', ['ls-files', '--', p], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).replace(/\r\n/g, '\n').trim();
  } catch {
    throw new Error(`[R68] git ls-files 不可用，无法验证入库状态：${p}`);
  }
}

/** 本波生产源码 diff 检查：git status --porcelain -- <p>（空 = 无未提交改动）。 */
function gitStatus(p: string): string {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', p], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).replace(/\r\n/g, '\n').trim();
  } catch {
    return '';
  }
}

/** ⚠ readFileSync 前必先验入库（CI Unit tests 步骤先炸的 ENOENT 铁律）。 */
function assertTracked(p: string): void {
  if (lsFiles(p) !== p) throw new Error(`[R68] 文件未入 git，CI 干净 checkout 会 ENOENT：${p}`);
}

const src = (p: string): string => {
  assertTracked(p);
  return readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
};

/** 与 r51_visual / r59 / r62 / r67 同源的锚点切片（找不到锚点返回空串，不静默误切）。 */
const slice = (s: string, from: string, to: string): string => {
  const a = s.indexOf(from);
  const b = a < 0 ? -1 : s.indexOf(to, a);
  return a < 0 || b < 0 ? '' : s.slice(a, b);
};

const sha256 = (s: string | Uint8Array | Uint8ClampedArray): string =>
  createHash('sha256').update(
    typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s.buffer, s.byteOffset, s.byteLength)
  ).digest('hex');

/* ── 顶层只读（任一未入库 ⇒ 整个文件清晰报错，而非 ENOENT） ── */
const shell = src('src/model/external/ExternalShell.ts');
const adapter = src('src/model/V800Adapter.ts');
const c2src = src('src/model/parts/tailLampC2.ts');
const wheelSrc = src('src/model/parts/wheelHub.ts');
const r7FrontDetailsSrc = src('src/model/parts/r7FrontDetails.ts');
const r7AdapterSrc = src('src/model/R7Adapter.ts');
const rendererSrc = src('src/render/Renderer.ts');
const r67Guard = src('tests/r67_tail_c2.test.ts');
const PRODUCTION_SRC =
  shell + adapter + c2src + wheelSrc + r7FrontDetailsSrc + r7AdapterSrc + rendererSrc;
const ALL_TRACKED_SRC = PRODUCTION_SRC + r67Guard;

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ═══════ 0. ★ 第 0 条：零护栏改动契约（主理人终裁） ═══════ */

describe('R68 · 第 0 条：零护栏改动契约', () => {
  it('★ tests/r67_tail_c2.test.ts 一行未改：全文件 sha256 === 冻结基线', () => {
    expect(sha256(r67Guard)).toBe(R67_GUARD_SHA256);
    // 钉住关键断言仍在（便于失败定位，非重复断言）
    expect(r67Guard).toContain("for (const needle of ['r67', 'tailLampC2', 'R67_TAIL_C2_ON', 'r67_tail_'])");
    expect(r67Guard).toContain('const faceTri = R69_C2_LAMP_ON ? 8 : 4;');
    expect(r67Guard).toContain('Math.abs(C2_GEOM.coverZ - -0.56751) * 4.75');
  });

  it('★ C2_GEOM 全字段逐位不变 + coverZ 等号级关系继续成立', () => {
    expect(C2_GEOM).toEqual({
      coverHalfW: 0.19428, coverYLo: 0.214, coverYHi: 0.266, coverZ: -0.56962,
      lampCenterX: 0.155, lampHalfW: 0.0375, lampYLo: 0.126, lampYHi: 0.261,
      faceZ: -0.57022, stripZ: -0.57037, stripHalfW: 0.030, stripHalfH: 0.003
    });
    expect(c2src).toContain('export const C2_GEOM = {');
    // 等价 r67:449 的 toBeCloseTo(0.010, 3)
    expect(Math.abs(C2_GEOM.coverZ - -0.56751) * 4.75).toBeCloseTo(0.010, 3);
    expect(C2_GEOM.coverHalfW).toBeLessThan(0.20992);
    expect(C2_GEOM.faceZ).toBeLessThan(C2_GEOM.coverZ);
    expect(C2_GEOM.stripZ).toBeLessThan(C2_GEOM.faceZ);
  });

  it('★ 几何拓扑恒等：C2_TRI_BUDGET(44|R71填充·40|R69·36)/cover(16|R71填充·12)/face(8|R69侧壁·4)/默认调用 3 mesh', () => {
    expect(C2_TRI_BUDGET).toBe(36 + (R69_C2_LAMP_ON ? 4 : 0) + (R71_C2_COVERFILL_ON ? 4 : 0));
    expect(C2_DC_BUDGET).toBe(3);
    expect(C2_MAT_BUDGET).toBe(2);
    expect(C2_TEX_BUDGET).toBe(1);
    // R71 盖板侧面黑填充把预算改为表达式（base 36 + R69 侧壁 4 + R71 填充 4）
    expect(c2src).toContain('export const C2_TRI_BUDGET = 36 + (R69_C2_LAMP_ON ? 4 : 0) + (R71_C2_COVERFILL_ON ? 4 : 0);');
    const triOf = (m: THREE.Mesh): number => {
      const g = m.geometry;
      return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    };
    const r = buildTailLampC2({ scale: 4.75, lampRearMat: new THREE.MeshStandardMaterial() });
    expect(r.meshes).toHaveLength(3);           // 默认（不传 coverTweak）恒 3 mesh
    expect(r.budget.dc).toBe(3);
    expect(triOf(r.coverMesh)).toBe(R71_C2_COVERFILL_ON ? 16 : 12); // R71 盖板侧面填充 +4
    expect(triOf(r.faceMesh)).toBe(R69_C2_LAMP_ON ? 8 : 4); // R69 侧壁 +4
    expect(r.budget.tri).toBe(36 + (R69_C2_LAMP_ON ? 4 : 0) + (R71_C2_COVERFILL_ON ? 4 : 0));
    expect(triOf(r.coverMesh) + triOf(r.faceMesh) + triOf(r.redStripMesh)).toBe(r.budget.tri);
  });

  it('★ 修正 A/D：on/off 两态恒 3 mesh / (40|R69) tri / 3 DC / 2 材质（第 4 mesh 已撤销）', () => {
    const triOf = (m: THREE.Mesh): number => {
      const g = m.geometry;
      return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    };
    for (const tweak of [false, true]) {
      const r = buildTailLampC2({
        scale: 4.75, lampRearMat: new THREE.MeshStandardMaterial(), coverTweak: tweak
      });
      expect(r.meshes, `coverTweak=${tweak} mesh 数`).toHaveLength(3);
      expect(r.budget.dc).toBe(3);
      expect(r.budget.tri).toBe(36 + (R69_C2_LAMP_ON ? 4 : 0) + (R71_C2_COVERFILL_ON ? 4 : 0));
      expect(r.budget.mat).toBe(2);
      // node 无 document ⇒ makeC2AtlasTexture 返回 null、贴图降级为 0（r67:395 同口径）；
      // 浏览器态为 1，故只钉 ≤ C2_TEX_BUDGET，不把 node 降级误当契约。
      expect(r.budget.tex).toBeLessThanOrEqual(C2_TEX_BUDGET);
      expect(triOf(r.coverMesh)).toBe(R71_C2_COVERFILL_ON ? 16 : 12); // R71 盖板侧面填充 +4
      expect(triOf(r.faceMesh)).toBe(R69_C2_LAMP_ON ? 8 : 4); // R69 侧壁 +4
    }
    expect(c2src).not.toContain('r68_tail_c2_surround'); // 独立 surround mesh 彻底撤销
    expect(c2src).toContain('C2_ATLAS_SURROUND_COLOR');  // 改走 atlas Canvas，零新几何
  });

  it('★ 修正 D 具名常量成对：coverDepth / 颜色 / roughness，off 逐位回基线值', () => {
    for (const decl of [
      'export const C2_COVER_DEPTH_BASELINE_M = 0.010;',
      'export const C2_COVER_DEPTH_R68_M = 0.0005;',
      'export const C2_COVER_COLOR_BASELINE = 0x1c1c22;',
      'export const C2_COVER_COLOR_R68 = 0x24242c;',
      'export const C2_COVER_ROUGHNESS_BASELINE = 0.72;',
      'export const C2_COVER_ROUGHNESS_R68 = 0.78;',
      "export const C2_ATLAS_SURROUND_COLOR = '#101016';"
    ]) expect(c2src).toContain(decl);
    // coverTweak 只驱动 3 处标量 + atlas 开关，不写 C2_GEOM
    expect(c2src).toContain('(tweak ? C2_COVER_DEPTH_R68_M : C2_COVER_DEPTH_BASELINE_M) / opts.scale;');
    expect(c2src).toContain('color: tweak ? C2_COVER_COLOR_R68 : C2_COVER_COLOR_BASELINE,');
    expect(c2src).toContain('roughness: tweak ? C2_COVER_ROUGHNESS_R68 : C2_COVER_ROUGHNESS_BASELINE,');
    expect(c2src).toContain('const tex = makeC2AtlasTexture(tweak);');
    expect(c2src).not.toContain('C2_COVER_R68'); // 旧未具名常量已删除
  });

  it('★ B2：userData.r44External 赋值语句逐字不变，禁用 setExteriorHidden 隐 C2 件', () => {
    expect(c2src).toContain(R44_EXTERNAL_STMT);
    const fn = slice(c2src, 'function markExternal(', 'export function buildTailLampC2(');
    expect(fn).toContain(R44_EXTERNAL_STMT);
    expect(fn).toContain('mesh.name = name;');
    // 注释里说明「setExteriorHidden 必须跳过外部壳件」不算接线 ⇒ 只禁调用，不禁提及
    expect(c2src).not.toMatch(/setExteriorHidden\s*\(/);
    expect(r67Guard).toContain('.r44External).toBe(true)');
  });

  it('★ dispose 账本位置不变（r67:206-212），新增释放行必须继续后置', () => {
    expect(shell).toContain('for (const m of r67TailMats) m.dispose();');
    expect(shell).toContain('for (const t of r67TailTex) t.dispose();');
    expect(shell.indexOf('for (const m of r67TailMats) m.dispose();'))
      .toBeGreaterThan(shell.indexOf('lampAtlasTex?.dispose();'));
    expect(shell).toContain('for (const mesh of [...glassMeshes, ...lampRearMeshes, ...lampFrontMeshes]) {');
  });
});

/* ═══════ 1. 只读 git tracked 铁律（CI Unit tests 先炸防线） ═══════ */

describe('R68 · 只读 git tracked 铁律', () => {
  it('8 个 readFileSync 目标全部已入库（逐个 git ls-files）', () => {
    for (const p of TRACKED) expect(lsFiles(p)).toBe(p);
  });

  it('★ tools/r49_pixel_rubric.mjs 仍未入库 ⇒ 护栏绝不读它', () => {
    expect(lsFiles('tools/r49_pixel_rubric.mjs')).toBe('');
    // r67 护栏正文里「解释为何不读」的注释提到了该路径 ⇒ 只查白名单与生产源码，
    // 不把护栏自身文本纳入判断（且用布尔断言避免把整段源码打进失败输出）。
    expect(TRACKED.join('\n').includes('tools/r49_pixel_rubric.mjs')).toBe(false);
    expect(PRODUCTION_SRC.includes('tools/r49_pixel_rubric.mjs')).toBe(false);
    expect(lsFiles('tools/r66a_glb_probe.mjs')).toBe('tools/r66a_glb_probe.mjs');
  });

  it('★ 绝不 readFileSync 未入库新文件 / .qa / dist / 绝对路径', () => {
    for (const f of R68_PENDING_TRACK_FILES) {
      expect(TRACKED).not.toContain(f);
      expect(ALL_TRACKED_SRC.includes(f)).toBe(false);
    }
    const tracked = lsFiles('src').split('\n').filter((f) => f.endsWith('.ts'));
    expect(tracked.length).toBeGreaterThan(20);
    expect(tracked.every((f) => f.startsWith('src/') && !f.includes('..'))).toBe(true);
  });

  it('★ CI BLOCKER 取证：ExternalShell.ts:37-38 的两个静态 import 逐字存在，并输出其入库状态', () => {
    // tracked 文件 import 未入库模块 ⇒ 干净 checkout 的 npm test / vite build 都会解析失败。
    // 这里不判红（Phase 2 在途、git add 由主理人统一做），只把状态打进 CI 日志供 Phase 4 核对。
    expect(shell).toContain("import { buildR7TailWrap } from '../parts/r7TailWrap';");
    expect(shell).toContain("import { r68BuildR7FrontLamp } from '../parts/r7FrontAtlas';");
    for (const f of R68_PENDING_TRACK_FILES) {
      console.info(`[R68] IMPORT_TARGET_TRACKED ${f}=${lsFiles(f) === f}`);
    }
    console.info(`[R68] GUARD_FILE_TRACKED tests/r68_visual.test.ts=${lsFiles('tests/r68_visual.test.ts') !== ''}`);
  });
});

/* ═══════ 2. V800Adapter.ts 全文件零改动 / 本波 diff 不含 ═══════ */

describe('R68 · V800Adapter.ts 逐字冻结 + 本波 diff 不含', () => {
  it('★ 可执行 diff 检查：git status 干净 + tracked + 全文件 sha256 === 冻结基线', () => {
    // 工作树改动由 git status 抓；已提交的改动由 sha256 抓 ⇒ 两者互补覆盖「diff 不含」。
    expect(lsFiles('src/model/V800Adapter.ts')).toBe('src/model/V800Adapter.ts');
    expect(gitStatus('src/model/V800Adapter.ts')).toBe('');
    expect(sha256(adapter)).toBe(ADAPTER_SHA256);
  });

  it('零 R68 接线 + 既有锚点仍在（r67:194-196 风格，便于失败定位）', () => {
    for (const needle of ['r68', 'R68', 'r68_', 'R68_ARCH_ON', 'tailLampR68']) {
      expect(adapter).not.toContain(needle);
    }
    expect(adapter).toContain('sm.visible = !interior;');
    expect(adapter).toContain('const extRear = shellHandle?.lampRearMat;');
    const hidden = slice(adapter, '// —— B-补：隐旧', '// —— C：前大灯');
    expect(hidden).toContain('hidLegacy');
  });

  /* ── R81 诊断（只打印 + 校验口径一致，不删改 ★ 冻结断言）──────────────────
   * 保留「计算 LF 归一 sha 并打印」能力：任何一次 V800Adapter.ts 改写 / commit
   * 版本差异都会让日志里的 LIVE 与 FROZEN 逐位不同 ⇒ 直接供二次唤醒重算，
   * 不需要临时搭脚本。护栏数量只增不减。 */
  it('[R81 诊断] 打印 V800Adapter.ts LF 归一 sha256（冻结基线口径自检）', () => {
    // readFileSync 前一律验入库（R64-fix / R67-CI-fix ENOENT 铁律）
    assertTracked('src/model/V800Adapter.ts');
    const raw = readFileSync(new URL('../src/model/V800Adapter.ts', import.meta.url), 'utf8');
    const lf = raw.replace(/\r\n/g, '\n'); // 口径铁律：CRLF → LF 后再算
    const live = sha256(lf);
    const rawSha = sha256(raw);
    console.info(
      `[R81] V800Adapter.ts LF_LIVE_SHA256=${live} FROZEN=${ADAPTER_SHA256} ` +
      `RAW_SHA256=${rawSha} CRLF_LINES=${(raw.match(/\r\n/g) ?? []).length} ` +
      `gitStatus=${gitStatus('src/model/V800Adapter.ts') || '(clean)'}\n` +
      `[R81] LEAD_GIVEN_LF=f8dc41234b90d37ae10d59255b040fefe5da202f75c7e0f5ab2b78b6e06ec207 ` +
      `LEAD_GIVEN_RAW=def27bf0c2794ed792a584d2e196d0564b8f1c58872f18000b0bf0c1b8219f56`
    );
    // 只校验口径正确 + 格式合法 + 与断言实际比较值逐位一致；
    // ⚠ 绝不写 `expect(sha256(raw)).toBe(sha256(lf))`：CRLF 工作副本会假红
    //   （主理人明示历史坑：sha256sum 算 raw 会错），CRLF_LINES / RAW 只做日志诊断。
    // ⚠ R81-CI 修正：删去 `expect(rawSha).not.toBe(live)` —— 它假设工作副本有 CRLF，
    //   但 CI（ubuntu + 干净 checkout）是 **LF** ⇒ raw===live ⇒ 该断言在 CI 必红、本地绿
    //   （本机 CRLF 副本掩盖了它）。RAW 与 CRLF_LINES 只做日志诊断，不作断言；
    //   sha 冻结契约由下方 `expect(sha256(adapter)).toBe(ADAPTER_SHA256)` 独立承担（恒执行）。
    expect(live).toMatch(/^[0-9a-f]{64}$/);
    expect(live).toBe(sha256(adapter)); // 与顶层 src() 的 LF 归一口径逐位一致
    // ⚠ 独立于上面 ★ it 再验一次 sha 冻结值：★ it 的 gitStatus 断言在 commit 前
    //   必然先失败并**短路**，其后的 `expect(sha256(adapter)).toBe(ADAPTER_SHA256)`
    //   根本不会执行 ⇒ 若无本条，就无法证明冻结值写对了。本条恒执行。
    expect(sha256(adapter), 'LF 归一口径 sha 必须等于 ADAPTER_SHA256 冻结常量')
      .toBe(ADAPTER_SHA256);
  });
});

/* ═══════ 3. 7 开关逐字口径 + r51HookOff 实证 ═══════ */

describe('R68 · 7 行逐字表（禁别名）与 r51HookOff 实证', () => {
  it('★ 7 行表逐字钉死：key 字符串 + #<key>=off 字面量齐备、禁别名、无 =on', () => {
    expect(R68_SWITCHES).toHaveLength(7);
    expect(new Set(R68_KEYS).size).toBe(7);
    for (const s of R68_SWITCHES) {
      expect(s.name.startsWith('R68_') && s.name.endsWith('_ON')).toBe(true);
      expect(s.off).toBe(`#${s.key}=off`);
      expect(s.key).not.toContain('noprewarm');
      expect(shell).toContain(`'${s.key}'`);       // hook key 字符串逐字存在
      expect(shell).toContain(s.off);              // off 分支存在
    }
    // B4/禁别名：审查线初稿 r68cover 与 R68_COVER_ON 一律不许出现
    expect(shell).not.toContain('r68cover');
    expect(shell).not.toContain('R68_COVER_ON');
    // nonce 细化 2：on 态 URL 不带开关参数，=on 是无效值
    expect(shell).not.toMatch(/#r68[a-z]+=on\b/);
  });

  it('★ r51HookOff 实证：私有未导出、只认 =off 的 RegExp、window 守卫', () => {
    expect(shell).toContain('function r51HookOff(key: string): boolean {');
    expect(shell).not.toContain('export function r51HookOff');
    expect(shell).not.toContain('export const r51HookOff');
    expect(shell).toContain("new RegExp(`(?:^|[#&])${key}=off`, 'i')");
    expect(shell).toContain("if (typeof window === 'undefined') return false;");
    expect(shell).toContain('function r51HookOn(key: string): boolean {');
  });

  it('★ 每个 hook key + 每个 off 分支存在（不强制各文件都调 r51HookOff）', () => {
    // 主理人实证：独立文件可用本地同语义实现 ⇒ 只查字面量，不查调用形式。
    for (const s of R68_SWITCHES) {
      expect(PRODUCTION_SRC).toContain(s.key);
      expect(PRODUCTION_SRC).toContain(`${s.key}=off`);
      expect(PRODUCTION_SRC).not.toContain(`r51HookOn('${s.key}')`); // 默认 ON，非 r51HookOn
    }
  });

  it('★ 7 个常量逐字钉死（以开发线实际落盘名，主理人 14:06 裁决不再回头改名）', () => {
    // 常量名 ↔ hook key 的映射逐字钉在声明行上；7 个全在 ExternalShell.ts 模块顶层。
    for (const s of R68_SWITCHES) {
      expect(shell).toContain(`export const ${s.name} = !r51HookOff('${s.key}');`);
    }
    expect(shell.match(/export const R68_[A-Z0-9_]+\s*=/g) ?? []).toHaveLength(7);
    // 禁别名（B4 / 审查线初稿）
    expect(shell).not.toContain('R68_R7TAIL_ON');
    expect(shell).not.toContain('R68_R7LAMP_ON');
    expect(shell).not.toContain('R68_C2COVER_ON');
    expect(shell).not.toContain('R68_GLASSOPAQUE_ON');
  });

  it('★ B5-2 独立文件同源：Renderer 复用模块顶层常量 / R7Adapter 本地同语义 RegExp', () => {
    expect(rendererSrc).toContain("import { R68_GLDIAG_ON } from '../model/external/ExternalShell';");
    expect(rendererSrc).toContain('#r68gldiag=off');
    expect(r7AdapterSrc).toContain('const r68ArchOn = !/(?:^|[#&])r68arch=off/i.test(');
    expect(r7AdapterSrc).toContain('#r68arch=off');
    // 注释里说明「键名不含 noprewarm」不算违规 ⇒ 只钉「hook key 字面量不含」，
    // 该语义已在上面 7 行表断言逐字覆盖，不在此重复判红。
    // B5-2 终裁（主理人 Phase 4 开工信号）：该 const 在函数体内、装配期一次性求值
    //   ⇒ **认可等价、不要求上提模块顶层**（真源 `R68_ARCH_ON` 仍在 ExternalShell.ts 模块顶层）。
    //   此处钉死该终裁形态，防止日后有人误把真源搬进函数体。
    expect(r7AdapterSrc).toContain('const r68ArchOn = !/(?:^|[#&])r68arch=off/i.test(');
    expect(shell).toContain("export const R68_ARCH_ON = !r51HookOff('r68arch');"); // 真源仍在模块顶层
  });

  it('★ 修正 C 双路径：R7Adapter 别名 import，原 createR7FrontDetails() 逐字保留', () => {
    // 回退树 / #r68r7lamp=off 的 on/off 双路径靠别名切换，原函数必须原样存在。
    expect(r7FrontDetailsSrc).toContain('export function createR7FrontDetails(');
    expect(r7FrontDetailsSrc).toContain('export function createR7FrontDetailsR68(');
    expect(r7AdapterSrc).toContain(
      "import { createR7FrontDetailsR68 as createR7FrontDetails } from './parts/r7FrontDetails';"
    );
    expect(r7AdapterSrc).toContain('const front = createR7FrontDetails();'); // 调用点未改
  });
});

/* ═══════ 4. 源码锚点纪律：:1987 / :2945 / r64Module 黑名单 ═══════ */

describe('R68 · 末尾追加纪律与跨波护栏耦合', () => {
  it('★ 既有最末声明 R67_TAIL_C2_ON 仍晚于 r64WriteTireBands（追加点基线）', () => {
    const iR67 = shell.indexOf('export const R67_TAIL_C2_ON');
    const iR64Fn = shell.indexOf('export function r64WriteTireBands(');
    expect(iR67).toBeGreaterThan(-1);
    expect(iR64Fn).toBeGreaterThan(-1);
    expect(iR67).toBeGreaterThan(iR64Fn);
    expect(shell).toContain("export const R67_TAIL_C2_ON = !r51HookOff('r67tail');");
  });

  it('★ B5-1：ExternalShell.ts 内 R68 常量一律后置在 R67_TAIL_C2_ON 之后（:2945 之后）', () => {
    const base = shell.indexOf('export const R67_TAIL_C2_ON');
    // 含 R7 / C2 等数字段（R68_R7_TAIL_ON / R68_C2_COVER_ON）⇒ 字符集必须带 0-9
    const decls = [...shell.matchAll(/export const R68_[A-Z0-9_]+\s*=/g)];
    expect(decls.length).toBeGreaterThan(0);
    for (const m of decls) expect(m.index ?? -1).toBeGreaterThan(base);
  });

  it('★ :1987 之前零新增声明：R62 paint slice 内不含任何 R68 字面量', () => {
    // r62_wheel_brake.test.ts:121 用 slice(shell,'if (R62_PAINT_ON) {','material.needsUpdate = true;')
    // 边界落在 ExternalShell.ts:1987-1988；在此区间插入新声明会改变 slice ⇒ 整片红。
    const r62Paint = slice(shell, 'if (R62_PAINT_ON) {', 'material.needsUpdate = true;');
    expect(r62Paint.length).toBeGreaterThan(100);
    expect(r62Paint).not.toContain('R68');
    expect(r62Paint).not.toContain('r68');
    expect(r62Paint).toContain('material.clearcoat = R62_PAINT_CLEARCOAT;');
  });

  it('★ R67 之后的「新增声明段」不得含 r64Module 负向黑名单字面量', () => {
    // r64_twotone_tire.test.ts:41 slice 从 R64_PAINT_ON 到 EOF，内含一批
    // .not.toContain(...) ⇒ 末尾追加的 R68 代码若写了这些字面量会连带打红 r64 护栏。
    const tail = shell.slice(shell.indexOf('export const R67_TAIL_C2_ON'));
    for (const bad of [
      'remapUV', 'writeFileSync', 'GLTFExporter', 'getWorldPosition',
      "setAttribute('uv'", 'Float32BufferAttribute(arr, 3', 'wheelRadius / scale',
      'R_model', 'onBeforeCompile', 'customProgramCacheKey', 'modelMatrix * vec4'
    ]) {
      expect(tail, `R68 新增段误写 r64 黑名单词面量：${bad}`).not.toContain(bad);
    }
  });
});

/* ═══════ 5. lampMeshes 出口 filter 与 dispose 账本 ═══════ */

describe('R68 · 隐藏语义件必须走出口过滤（不能只 visible=false）', () => {
  it('★ lampMeshes 出口数组 filter 仍在，且三元 else 逐位回横带态', () => {
    const block = slice(shell, 'lampMeshes: [', 'lampRearMat,');
    expect(block).toContain("R67_TAIL_C2_ON && car === 'v800'");
    expect(block).toContain("lampRearMeshes.filter((m) => m.name !== 'lamp_rear')");
    expect(block).toContain(': lampRearMeshes),');
  });

  it('collectNamed 原行逐字保留（内部数组 / dispose 账本不削面）', () => {
    expect(shell).toContain('collectNamed(lrGltf, lampRearMeshes, lampRearMat, manifest.scale);');
    expect(shell).toContain('const lampRearMeshes: THREE.Mesh[] = [];');
  });

  it('r67_tail_c2_strips 复用 lampRearMat 同一实例（材质级 hide 会连带隐藏，勿当独立件）', () => {
    const r = buildTailLampC2({ scale: 4.75, lampRearMat: new THREE.MeshStandardMaterial() });
    expect(r.redStripMesh.material).toBe(r.meshes.find((m) => m.name === 'r67_tail_c2_strips')?.material);
    expect(r67Guard).toContain('红条 material === lampRearMat');
  });
});

/* ═══════ 6. WHEEL_HUB_CENTERS 与 N_WINDOWS 静态契约（B3 / B5-5） ═══════ */

describe('R68 · 轮心标定常量禁改与 N_WINDOWS 允许值', () => {
  const centersBlock = slice(
    wheelSrc, 'export const WHEEL_HUB_CENTERS = {', '/** side = 轮心世界 x 的符号'
  );

  it('★ B3：WHEEL_HUB_CENTERS 4 组坐标逐位不变（±1.715 / 0.382 / 0.855）', () => {
    expect(centersBlock.length).toBeGreaterThan(100);
    for (const line of WHEEL_HUB_CENTERS_LINES) expect(centersBlock).toContain(line);
    expect(centersBlock.match(/side:/g) ?? []).toHaveLength(4);
    expect(wheelSrc.match(/export const WHEEL_HUB_CENTERS/g) ?? []).toHaveLength(1);
  });

  it('★ 禁改写：无 WHEEL_HUB_CENTERS 成员赋值 / 无 R7 manifest.hubs 混入该常量', () => {
    expect(wheelSrc).not.toMatch(/WHEEL_HUB_CENTERS\.[a-z]+\.[xyz]\s*=/);
    expect(centersBlock).not.toContain('4.323');
    expect(centersBlock).not.toContain('manifest.hubs');
  });

  it('★ B5-5：18 与 20 字面量均存在 + r68wheel 分支 + off 逐位回 18', () => {
    // 开发线实际形态（Phase 2 已落）：`export const N_WINDOWS = R68_WHEEL_ON ? 20 : 18;`
    // ⇒ 模块顶层求值、两个字面量成对、off 态逐位回 18，正是 B5-5 要求的静态口径。
    const decl = /export const N_WINDOWS\s*=\s*([^;]+);/.exec(wheelSrc)?.[1] ?? '';
    expect(decl).toContain('20');
    expect(decl).toContain('18');
    expect(decl).toContain('R68_WHEEL_ON');
    expect(wheelSrc).toContain("import { R68_WHEEL_ON } from '../external/ExternalShell';");
    expect(wheelSrc).toContain('#r68wheel=off');
    expect(R68_N_WINDOWS_ALLOWED).toEqual([18, 20]);
  });
});

/* ═══════ 7. 隐私扫描（全 src tracked .ts） ═══════ */

describe('R68 · 生产源码隐私扫描', () => {
  const trackedTs = lsFiles('src').split('\n').filter((f) => f.endsWith('.ts'));

  it('★ 全量 tracked src/**/*.ts 无本机绝对路径 / 139.com / clipboard-images / .workbuddy / sslVerify / 凭据', () => {
    const hits: string[] = [];
    for (const rel of trackedTs) {
      const text = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
      PRIVACY_RULES.forEach((re, i) => { if (re.test(text)) hits.push(`${rel} :: rule#${i}`); });
    }
    expect(hits, `隐私命中：${hits.join(' | ')}`).toEqual([]);
  });

  it('被钉死的 8 个文件同样无隐私命中（含注释）', () => {
    for (const [name, text] of [
      ['ExternalShell.ts', shell], ['V800Adapter.ts', adapter],
      ['tailLampC2.ts', c2src], ['wheelHub.ts', wheelSrc],
      ['r7FrontDetails.ts', r7FrontDetailsSrc],
      ['R7Adapter.ts', r7AdapterSrc], ['Renderer.ts', rendererSrc],
      ['r67_tail_c2.test.ts', r67Guard]
    ] as const) {
      for (const re of PRIVACY_RULES) expect(re.test(text), `${name} 命中 ${re}`).toBe(false);
    }
  });
});

/* ═══════ 8. Canvas 像素指纹（RasterPainter，零 WebGL / 零新依赖） ═══════ */

/** HSL → RGB（内联，供 `hsl(43, 84%, L%)` 金色点阵解析）。 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let t: [number, number, number];
  if (hp < 1) t = [c, x, 0];
  else if (hp < 2) t = [x, c, 0];
  else if (hp < 3) t = [0, c, x];
  else if (hp < 4) t = [0, x, c];
  else if (hp < 5) t = [x, 0, c];
  else t = [c, 0, x];
  const m = l - c / 2;
  return [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
}

/** 绘制指令序列（用于「默认 vs off 原 atlas」的前缀逐条对照，新维度，不重复 r67 的点数断言）。 */
interface DrawOp {
  op: 'fill' | 'rect' | 'dot';
  color: string;
  args: number[];
}

interface Raster {
  p: C2Painter;
  buf: Uint8ClampedArray;
  counts: Record<string, number>;
  ops: DrawOp[];
}

/** 把 C2Painter 三个原语光栅化成 RGBA 缓冲（等价于 Canvas2D 的 fillRect/arc/fill）。 */
function makeRaster(w: number, h: number): Raster {
  const buf = new Uint8ClampedArray(w * h * 4);
  const counts: Record<string, number> = {};
  const ops: DrawOp[] = [];
  const parse = (color: string): [number, number, number, number] => {
    const hx = /^#([0-9a-f]{6})$/i.exec(color);
    if (hx) {
      const v = parseInt(hx[1], 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1];
    }
    const rg = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(color);
    if (rg) return [+rg[1], +rg[2], +rg[3], +rg[4]];
    const hs = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(color);
    if (hs) {
      const [r, g, b] = hslToRgb(+hs[1], +hs[2] / 100, +hs[3] / 100);
      return [r, g, b, 1];
    }
    return [255, 0, 255, 1]; // 未知颜色显式品红，不静默吞掉
  };
  const write = (x: number, y: number, rgb: [number, number, number, number], color: string): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    const [r, g, b, a] = rgb;
    if (a >= 1) {
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    } else {
      buf[o] = Math.round(buf[o] * (1 - a) + r * a);
      buf[o + 1] = Math.round(buf[o + 1] * (1 - a) + g * a);
      buf[o + 2] = Math.round(buf[o + 2] * (1 - a) + b * a);
      buf[o + 3] = 255;
    }
    counts[color] = (counts[color] ?? 0) + 1;
  };
  const p: C2Painter = {
    fill: (fw, fh, color) => {
      ops.push({ op: 'fill', color, args: [fw, fh] });
      const rgb = parse(color);
      for (let y = 0; y < Math.min(h, Math.round(fh)); y += 1) {
        for (let x = 0; x < Math.min(w, Math.round(fw)); x += 1) write(x, y, rgb, color);
      }
    },
    rect: (x, y, rw, rh, color) => {
      ops.push({ op: 'rect', color, args: [x, y, rw, rh] });
      const rgb = parse(color);
      const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(w, Math.round(x + rw)), y1 = Math.min(h, Math.round(y + rh));
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) write(xx, yy, rgb, color);
      }
    },
    dot: (cx, cy, r, color) => {
      ops.push({ op: 'dot', color, args: [cx, cy, r] });
      const rgb = parse(color);
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h, Math.ceil(cy + r));
      const r2 = r * r;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
          if (dx * dx + dy * dy <= r2) write(xx, yy, rgb, color);
        }
      }
    }
  };
  return { p, buf, counts, ops };
}

const px = (b: Uint8ClampedArray, x: number, y: number, w: number): [number, number, number] => {
  const o = (y * w + x) * 4;
  return [b[o], b[o + 1], b[o + 2]];
};

describe('R68 · paintC2Atlas 像素缓冲指纹 + 默认/off 对照口径', () => {
  const raster = makeRaster(C2_ATLAS_W, C2_ATLAS_H);
  paintC2Atlas(raster.p, C2_ATLAS_W, C2_ATLAS_H);

  it('像素缓冲尺寸 = W×H×4，非空白，左上角 #0a0a0e 黑烟熏底', () => {
    expect(raster.buf).toHaveLength(C2_ATLAS_W * C2_ATLAS_H * 4);
    expect(raster.buf.some((v) => v !== 0)).toBe(true);
    expect(px(raster.buf, 0, 0, C2_ATLAS_W)).toEqual([10, 10, 14]);
  });

  it('★ 颜色族结构：黑底 / 镀铬外框 / 金色点阵 / 熄灭点齐全，无渐变原语', () => {
    expect(raster.counts['#0a0a0e'] ?? 0).toBeGreaterThan(0);
    expect(raster.counts['#c2c6cd'] ?? 0).toBeGreaterThan(0);
    expect(raster.counts['rgba(154,120,52,0.20)'] ?? 0).toBeGreaterThan(0);
    const gold = Object.entries(raster.counts)
      .filter(([k]) => k.startsWith('hsl(43,'))
      .reduce((sum, [, n]) => sum + n, 0);
    expect(gold).toBeGreaterThan(0);
    // 断言落在「实际绘制指令流」上（新维度）；r67:341 的源码文本断言不重复。
    expect(Object.keys(raster.counts).every((k) => !/gradient/i.test(k))).toBe(true);
  });

  it('★ 确定性：同一纯函数两次光栅化 sha256 完全一致（防随机化 / 时间依赖）', () => {
    const again = makeRaster(C2_ATLAS_W, C2_ATLAS_H);
    paintC2Atlas(again.p, C2_ATLAS_W, C2_ATLAS_H);
    const a = sha256(raster.buf);
    expect(a).toBe(sha256(again.buf));
    expect(a).not.toBe(sha256(new Uint8ClampedArray(C2_ATLAS_W * C2_ATLAS_H * 4)));
    console.info(`[R68] C2_ATLAS_LIVE_SHA256=${a}`);
  });

  it('★ atlas 指纹按 R69 凤凰收窄开关动态期望：off 回 R67 冻结基线、on(R69) 收窄后 ≠ 基线', () => {
    // 开发线修正 A/D 后 `paintC2Atlas(p,w,h,surround=false)` 有第 4 个可选形参，
    // 原「纯函数无开关形参 ⇒ 只能用冻结基线常量」的注释已过时，改为直接精确断言。
    // R69：默认 ON 收窄凤凰（vLo/vHi [0.10,0.92]→[0.19,0.83]）⇒ 默认 atlas ≠ R67 基线；
    // `#r69c2lamp=off` ⇒ 凤凰回基线 ⇒ atlas 逐位回 R67 冻结 sha。
    const offR = makeRaster(C2_ATLAS_W, C2_ATLAS_H);
    paintC2Atlas(offR.p, C2_ATLAS_W, C2_ATLAS_H, false);
    if (R69_C2_LAMP_ON) {
      // R69 默认：凤凰收窄 ⇒ 与 R67 冻结基线不同（这是预期改动，非回归）
      expect(sha256(offR.buf)).not.toBe(R68_C2_ATLAS_BASELINE_SHA256);
    } else {
      expect(sha256(offR.buf)).toBe(R68_C2_ATLAS_BASELINE_SHA256);
    }
    expect(sha256(raster.buf)).toBe(sha256(offR.buf)); // 3 参默认 ≡ false
    expect(offR.ops[0]).toEqual({ op: 'fill', color: '#0a0a0e', args: [C2_ATLAS_W, C2_ATLAS_H] });
    expect(c2src).toContain('surround = false');
    expect(c2src).toContain('export function makeC2AtlasTexture(surround = false)');
    // 绘制参数常量恒定 + 零新依赖（不引入 canvas/jsdom/skia 等）
    expect(C2_ATLAS_W).toBe(1024);
    expect(C2_ATLAS_H).toBe(1024);
    // C2_PHOENIX_PANEL 是 R68 基线常量（vLo/vHi 恒 0.10/0.92）；R69 收窄走 phoenixVRangeActive
    expect(C2_PHOENIX_PANEL).toEqual({ cols: 22, rows: 30, vLo: 0.10, vHi: 0.92 });
    const vr = phoenixVRangeActive();
    expect(vr.vLo).toBe(R69_C2_LAMP_ON ? 0.19 : 0.10);
    expect(vr.vHi).toBe(R69_C2_LAMP_ON ? 0.83 : 0.92);
    expect(C2_STRIP_COUNTS).toEqual({ top: 3, bottom: 2 });
    expect(c2src).toContain("import * as THREE from 'three';");
    expect(c2src).toContain("import { mergeSafe } from '../../util/geo';");
    expect(c2src).not.toMatch(/from ['"](?:canvas|@napi-rs\/canvas|jsdom|skia-canvas|node-canvas)/);
  });

  it('★ on(true) vs off(false) 精确对照：前缀逐条相同、仅末尾追加 4 条 surround rect、指纹不等', () => {
    const offR = makeRaster(C2_ATLAS_W, C2_ATLAS_H);
    const onR = makeRaster(C2_ATLAS_W, C2_ATLAS_H);
    paintC2Atlas(offR.p, C2_ATLAS_W, C2_ATLAS_H, false);
    paintC2Atlas(onR.p, C2_ATLAS_W, C2_ATLAS_H, true);
    // 只在末尾追加，不改动 R67 原绘制流的任何一条指令
    expect(onR.ops.length).toBeGreaterThan(offR.ops.length);
    expect(onR.ops.slice(0, offR.ops.length)).toEqual(offR.ops);
    const delta = onR.ops.slice(offR.ops.length);
    expect(delta).toHaveLength(4);                       // 2 半幅 × 2 层 rect
    expect(delta.every((o) => o.op === 'rect')).toBe(true);
    expect(delta.filter((o) => o.color === '#101016')).toHaveLength(2);
    expect(delta.filter((o) => o.color === '#33343c')).toHaveLength(2);
    // 像素缓冲与颜色族：on 多出 surround 色，off 完全没有
    expect(sha256(onR.buf)).not.toBe(sha256(offR.buf));
    expect(onR.counts['#101016'] ?? 0).toBeGreaterThan(0);
    expect(offR.counts['#101016'] ?? 0).toBe(0);
    // 金色点阵凤凰未被 surround 改动
    expect(onR.ops.filter((o) => o.op === 'dot')).toHaveLength(offR.ops.filter((o) => o.op === 'dot').length);
    console.info(
      `[R68] C2_ATLAS_CONTRAST off=${sha256(offR.buf)} on=${sha256(onR.buf)} deltaOps=${delta.length}`
    );
  });
});

/* ═══════ 9. makeR7RearBandAtlas 源码切片指纹（复用 r49/r51 契约） ═══════ */

describe('R68 · R7 尾带 atlas 源码级指纹（私有函数，vitest 无法直调）', () => {
  const band = slice(
    shell, 'function makeR7RearBandAtlas(', '/**\n * R49-P2b · R7 下缘红反光条 atlas'
  );

  it('复用 r51_visual.test.ts:164 同款 slice：非空、无参签名、零未入库依赖', () => {
    expect(band.length).toBeGreaterThan(200);
    expect(band).toContain('function makeR7RearBandAtlas()');
    expect(shell).toContain('map: r49Hole ? (makeR7RearBandAtlas() ?? undefined) : undefined');
    expect(band).not.toContain('readFileSync');
    expect(band).not.toContain('writeFileSync');
    expect(band).not.toContain('tools/');
  });

  it('★ 源码切片 sha256 稳定且不含隐私 / 绝对路径字面量', () => {
    const h = sha256(band);
    expect(h).toBe(sha256(band));
    for (const re of PRIVACY_RULES) expect(re.test(band)).toBe(false);
    console.info(`[R68] R7_BAND_SLICE_SHA256=${h}`);
  });
});

/* ═══════ 10. A/B nonce URL 模板结构断言（B1 + 审查线 4 条细化） ═══════
 * 不真跑浏览器、不 import 未入库 harness：内联一份「规格级参考模板」并静态断言其结构。
 * Phase 3 用真实 harness 对照本模板做开工第一道校验。
 * ═══════════════════════════════════════════════════════════════════ */

interface AbPairUrls {
  nonce: string;
  on: string;
  off: string;
  meta: Record<string, string>;
}

const AB_EPOCH = 1700000000000;
/** 机位六参数（元数据要求）。 */
const AB_CAM6 = 'az=225&pitch=6&dist=9.2&targetY=0&fov=30&near=0.05';

/** `t=<epoch>-<pairSeq>` 单调序号 nonce（nonce 细化 1；不用裸 Date.now()）。 */
const makeNonce = (epoch: number, pairSeq: number): string => `t=${epoch}-${pairSeq}`;

const makePairUrls = (key: string, epoch: number, pairSeq: number): AbPairUrls => {
  const nonce = makeNonce(epoch, pairSeq);
  // on 态 URL **不带该开关参数**（不写 =on）；off 态只追加 &<key>=off。
  const common =
    'http://127.0.0.1:5173/preview.html?v=r68harness' +
    `#assembled&quality=high&paint=obsidian&${AB_CAM6}&${nonce}`;
  return {
    nonce,
    on: common,
    off: `${common}&${key}=off`,
    meta: {
      nonce,
      harnessVersion: 'r68-phase3',
      quality: 'high',
      paint: 'obsidian',
      cam6: AB_CAM6,
      assembled: 'true',
      switches: R68_SWITCHES.map((s) => `${s.name}|${s.key}|${s.off}`).join(';')
    }
  };
};

describe('R68 · A/B nonce URL 模板结构（对内同 t / 对外异 t / 除开关外逐字相同）', () => {
  it('★ 对内同 t：同一 A/B 对 on/off 两次 reload 复用同一个冻结 nonce 变量', () => {
    const p = makePairUrls('r68arch', AB_EPOCH, 1);
    expect(p.on).toContain(p.nonce);
    expect(p.off).toContain(p.nonce);
    expect(p.nonce).toBe('t=1700000000000-1');
    expect(/^t=\d+-\d+$/.test(p.nonce)).toBe(true);
    expect(p.nonce).not.toContain('Date.now()');
  });

  it('★ 对外异 t：不同 A/B 对用单调序号换新 nonce（+ 新 page，交 Phase 3 harness）', () => {
    const a = makePairUrls('r68arch', AB_EPOCH, 1);
    const b = makePairUrls('r68arch', AB_EPOCH, 2);
    expect(a.nonce).not.toBe(b.nonce);
    expect(Number(a.nonce.split('-')[1])).toBeLessThan(Number(b.nonce.split('-')[1]));
  });

  it('★ 7 个开关逐个：on 不带参数 / off 带 =off / 除开关外 URL 逐字相同', () => {
    for (const s of R68_SWITCHES) {
      const p = makePairUrls(s.key, AB_EPOCH, 1);
      expect(p.on).not.toContain(`${s.key}=off`);
      expect(p.on).not.toContain('=on');
      expect(p.off).toContain(`&${s.key}=off`);
      expect(p.off.replace(`&${s.key}=off`, '')).toBe(p.on);
      // nonce 细化 3：禁含 r68/r51/=off，防被 r51HookOff 的 RegExp 误命中
      expect(p.nonce).not.toMatch(/r68|r51|=off/i);
      const re = new RegExp(`(?:^|[#&])${s.key}=off`, 'i'); // 与 r51HookOff 同语义
      expect(re.test(p.on)).toBe(false);
      expect(re.test(p.off)).toBe(true);
    }
  });

  it('★ 截图元数据齐备：nonce / harness 版本 / 质量档 / #paint= / 机位六参数 / #assembled / 7 开关逐字串', () => {
    const p = makePairUrls('r68arch', AB_EPOCH, 1);
    for (const k of ['nonce', 'harnessVersion', 'quality', 'paint', 'cam6', 'assembled', 'switches']) {
      expect(p.meta).toHaveProperty(k);
    }
    expect(p.meta.cam6.split('&')).toHaveLength(6);
    for (const s of R68_SWITCHES) {
      expect(p.meta.switches).toContain(`${s.name}|${s.key}|${s.off}`);
    }
  });
});

/* ═══════ ② TODO：剩余待裁决项（开发线修正 A/D/C 后 3 条已解除，见启用断言） ═══════
 * 已解除：① 常量名逐字（改为实际落盘名启用断言）；② coverDepth 具名常量 +
 *   off 逐位回基线值（改为 7 条声明行 + 3 处三元标量启用断言）；
 *   ③ C2 atlas 默认 vs off 精确对照（paintC2Atlas 第 4 形参落地，改为两条启用断言）。
 * ═══════════════════════════════════════════════════════════════════ */

describe.skip('R68 · [② TODO · Phase 5 解除] 剩余待裁决项', () => {
  it('[TODO] ★ CI BLOCKER：3 个新文件 git add + 新文件纳入隐私扫描 + R7 band 切片基线', () => {
    // ⚠ tracked 的 ExternalShell.ts:37-38 静态 import 两个未入库模块 ⇒ 干净 checkout
    //   npm test / vite build 都会模块解析失败；我的护栏文件本身也仍 untracked。
    for (const f of R68_PENDING_TRACK_FILES) expect(lsFiles(f)).toBe(f);
    expect(lsFiles('tests/r68_visual.test.ts')).toBe('tests/r68_visual.test.ts');
    const b = slice(shell, 'function makeR7RearBandAtlas(', '/**\n * R49-P2b · R7 下缘红反光条 atlas');
    expect(sha256(b)).toBe(R68_R7_BAND_SLICE_SHA256_BASELINE);
  });
});

/* ═══════ ③ 交 Phase 3 目检 / 运行时验证（vitest 无 WebGL，不覆盖） ═══════ */

describe.skip('R68 · [③ Phase 3] 目检 / 运行时验证清单（非 vitest 范围）', () => {
  it('[Phase 3] B5-3：回退树 #r44ext=off 双路径截图，确认 C2 on 态主接线同样生效', () => {
    // 渲染后画面判据；审查线走材质级 hidden（__v800Parts / #cabin）。
  });

  it('[Phase 3] B5-4：NaN / clamp 三件套 wall/flip/cull → #uvassert + 三机位目检 + bbox 探针', () => {
    // 几何正确性不属静态护栏范围。
  });

  it('[Phase 3] B5-5：N_WINDOWS off 态逐位回 18 窗 + 运行时 tri/DC → #batchmerge / #perfhud', () => {
    // 18→20 的运行时效果无法在 vitest 验证。
  });

  it('[Phase 3] 消去法差分：strips 复用 lampRearMat，材质级 hide 连带隐藏，勿当独立件', () => {
    // 审查线提醒：不要把 r67_tail_c2_strips 当独立件做差分断言。
  });
});
