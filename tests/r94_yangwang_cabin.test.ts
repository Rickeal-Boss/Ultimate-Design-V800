/**
 * R94 · 仰望车内「米黄色光面中间隔板」根治护栏
 *
 * 症状（用户真机截图）：`#vehicle=yangwang` 选仰望、切车内（HUD 主驾/副驾/后排），
 * 主驾视角一大片**米黄色光面**横贯几乎整个画面，读作一块「中间隔板」挡住视线。
 *
 * 定罪（`.qa/r94/probe_interior.ts`，Node 直构 + 主驾眼位 7×7 方向栅格 Raycaster）：
 *   本车以 `{interiorOnly:true}` 复用 V800 座舱 ⇒ V800Adapter 的外壳 IIFE 早退
 *   （`if (opts?.interiorOnly) return;`），于是
 *     1. `buildVisibilityTable(...)`（仅在外壳就绪回调里调用）从未执行
 *        ⇒ `matEntries`/`meshEntries` 恒空，`applyVisibility` 的 pass-1/pass-2 空转；
 *     2. `shellHandle == null` ⇒ `exteriorShellReady` 恒 false。
 *   ⇒ V800「外壳就绪后按内饰白名单永久隐藏程序化外观」那套幂等状态表整体失效，
 *     程序化**外壳件**（风挡 / 车身 / 轮胎 / 后视镜 / 车顶模块 / 车灯 / 铬条 …）全留在舱内：
 *     车内可见 mesh **133** 个。主驾眼位下 `windshield`（材质 `glass-clear`：
 *     roughness **0.03** / envMapIntensity **0.7** / opacity 0.66 = 近镜面反射板）命中
 *     **28/49 条射线 = 57% 画面**、贴脸 dmin 0.66m；后排眼点则被 `batch/paint-upper`
 *     （材质 `paint-upper` 香槟金 **#D3AC5D = 米黄色**，metalness 0.45 / roughness 0.38 = 光面）
 *     以 dmin **0.49m** 命中 **17/49**。
 *   修复（`cullV800ExteriorMaterials`，只写 `material.visible`）后：两者命中 **0/49**，
 *   车内可见 mesh 133 → **32**。
 *
 * 本护栏两层：
 *   ① **运行时**（动态 import 真适配器，Node 下 canvas 走最小 shim）：
 *      车内态下「外壳材质」必须全部不可见 + 主驾眼位射线不得命中风挡/车漆 + 可见 mesh 量级护栏；
 *   ② **白名单漂移**（源码字符串对比）：本车白名单逐位复刻 V800Adapter 的两张表，
 *      V800 侧一改 id 就在此处立刻红 —— 该两张表是 V800Adapter 的**函数内局部常量、未导出**，
 *      无法 import，只能按源码同步。
 *
 * ⚠ 不读 .qa / 不跑 git / 不渲染；只用 Node 内置 fs 读 src。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 只读已入库源码（LF 归一）。 */
function srcOf(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 最小 DOM shim（Node/vitest 无 document/window）。
 *
 * 与 `tests/r37_paint.test.ts` 的 shim() 同款约定，**唯一差别**：import 完成后立刻撤掉
 * `globalThis.window` —— 本测试要构造的是**第三辆车** `createYangwangCarAdapter`，它的
 * GLB 下载分支用 `typeof window !== 'undefined'` 门控；留下 window 会让探针在 Node 里
 * 真的去 fetch 一个 file:// GLB。而 `src/config/quality.ts` 的 TIERS 表在**模块求值期**
 * 读 `window.devicePixelRatio`，所以 import 期间必须短暂挂着。
 *
 * 纹理**内容**不参与几何 / 显隐判定，故所有绘制调用一律 no-op；getImageData 返回可写
 * 黑像素，保证 refTextures 的「二次采样」分支不崩。
 */
function installDomShim(): () => void {
  const REAL_WIN = (globalThis as { window?: unknown }).window;
  const REAL_DOC = (globalThis as { document?: unknown }).document;

  const grad = () => ({ addColorStop() {} });
  const ctx2d = () => {
    const base: Record<string, unknown> = {
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      font: '10px sans-serif',
      globalAlpha: 1,
      canvas: null,
      measureText: () => ({ width: 0 }),
      getLineDash: () => [],
      createLinearGradient: grad,
      createRadialGradient: grad,
      createConicGradient: grad,
      createPattern: () => null,
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(Math.max(1, w * h) * 4),
        width: Math.max(1, w),
        height: Math.max(1, h)
      })
    };
    return new Proxy(base, {
      get(t, k) {
        if (k in t) return (t as Record<string | symbol, unknown>)[k];
        return typeof k === 'symbol' ? undefined : () => {};
      },
      set(t, k, v) {
        (t as Record<string | symbol, unknown>)[k] = v;
        return true;
      }
    }) as unknown as CanvasRenderingContext2D;
  };
  const makeCanvas = (w: number, h: number) => {
    const ctx = ctx2d();
    const canvas = {
      width: Math.max(1, w | 0),
      height: Math.max(1, h | 0),
      style: {},
      getContext(kind: string) {
        return kind === '2d' ? ctx : null;
      },
      toDataURL: () => 'data:image/gif;base64,',
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect() {
        return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height };
      }
    };
    ctx.canvas = canvas;
    return canvas;
  };

  (globalThis as { window: unknown }).window = {
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 720,
    location: { hash: '', href: '' },
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  (globalThis as { document: unknown }).document = {
    createElement(tag: string) {
      return tag === 'canvas' ? makeCanvas(8, 8) : { style: {}, width: 0, height: 0 };
    },
    createTextNode: () => ({}),
    documentElement: { style: {} },
    body: { appendChild() {}, removeChild() {} },
    head: { appendChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createEvent: () => ({ initEvent() {} })
  };
  return () => {
    (globalThis as { window: unknown }).window = REAL_WIN;
    (globalThis as { document: unknown }).document = REAL_DOC;
    if (REAL_WIN === undefined) delete (globalThis as { window?: unknown }).window;
    if (REAL_DOC === undefined) delete (globalThis as { document?: unknown }).document;
  };
}

/** 与 YangwangAdapter 的修复同源的白名单（测试侧独立抄写一遍，防单文件内自洽漂移）。 */
const INTERIOR_IDS_EXPECTED = [
  'carpet', 'curtain', 'crystal', 'gauge-ui', 'headliner-suede', 'leather-dark',
  'leather-ivory', 'leather-warm', 'pillar-trim', 'screen-ui', 'starlight', 'wood'
];

/** 从源码里抽 `XXX = new Set<string>([ ... ]);` 的 id 列表（跨行、去注释）。 */
function extractSetLiterals(src: string, anchor: string): string[] {
  const i = src.indexOf(anchor);
  expect(i, `源码应含锚点 ${anchor}`).toBeGreaterThan(-1);
  const open = src.indexOf('[', i);
  expect(open, `锚点后应有数组字面量：${anchor}`).toBeGreaterThan(-1);
  const close = src.indexOf(']', open);
  expect(close).toBeGreaterThan(open);
  return src
    .slice(open, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/[\[\]\s]/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^['"]|['"]$/g, ''));
}

const YW_SRC = srcOf('src/model/YangwangAdapter.ts');
const V800_SRC = srcOf('src/model/V800Adapter.ts');

describe('R94 · 白名单漂移护栏（V800Adapter 局部常量 ↔ 本车复刻表）', () => {
  it('内饰材质白名单与 V800 R44_INTERIOR_MATERIAL_IDS 逐位一致', () => {
    const v800 = extractSetLiterals(V800_SRC, 'const R44_INTERIOR_MATERIAL_IDS = new Set<string>([');
    const yw = extractSetLiterals(YW_SRC, 'const V800_INTERIOR_MATERIAL_IDS: ReadonlySet<string> = new Set([');
    expect(yw.length).toBe(INTERIOR_IDS_EXPECTED.length);
    expect([...yw].sort()).toEqual([...v800].sort());
  });

  it('mesh 名白名单与 V800 R44_KEEP_MESH_NAMES 逐位一致', () => {
    const v800 = extractSetLiterals(V800_SRC, 'const R44_KEEP_MESH_NAMES = new Set<string>([');
    const yw = extractSetLiterals(YW_SRC, 'const V800_KEEP_MESH_NAMES: ReadonlySet<string> = new Set([');
    expect([...yw].sort()).toEqual([...v800].sort());
    expect(v800).toContain('cabin-roof-carpet');
  });

  it('装配期确实调用了裁切（且早于 body.add 之后的可见性入口）', () => {
    // 钉死调用点：裁切必须作用在 interiorRoot（= v800.body）上，且位于 body.add 之后
    const iAdd = YW_SRC.indexOf('body.add(interiorRoot);');
    expect(iAdd).toBeGreaterThan(-1);
    const iCull = YW_SRC.indexOf('cullV800ExteriorMaterials(interiorRoot);');
    expect(iCull, '装配期应调用 cullV800ExteriorMaterials(interiorRoot)').toBeGreaterThan(-1);
    expect(iCull).toBeGreaterThan(iAdd);
  });

  it('根因锚点仍在（buildVisibilityTable 只在外壳就绪回调里调用 + interiorOnly 早退）', () => {
    // 若 V800Adapter 改成无条件建表，本车的裁切就变成冗余（不算错，但须人工复核）
    const iEarly = V800_SRC.indexOf('if (opts?.interiorOnly) return;');
    const iBuild = V800_SRC.indexOf('buildVisibilityTable(shell.manifest.bodyBBox');
    expect(iEarly).toBeGreaterThan(-1);
    expect(iBuild).toBeGreaterThan(-1);
    expect(iBuild).toBeGreaterThan(iEarly);
  });
});

describe('R94 · 运行时护栏（真构造适配器，不渲染）', () => {
  it('车内态下程序化外壳材质全部不可见，主驾眼位不再命中米黄光面', async () => {
    const restore = installDomShim();
    try {
      const { createYangwangCarAdapter } = await import('../src/model/YangwangAdapter');
      // import 完成 ⇒ 模块求值期的 `window.*` 读法已落地；立刻撤掉 window，
      // 让 YangwangAdapter 的 GLB 下载分支（`typeof window !== 'undefined'`）保持关闭。
      delete (globalThis as { window?: unknown }).window;
      const car = createYangwangCarAdapter('high') as unknown as {
        root: import('three').Object3D;
        applyVisibility: (s: { interior: boolean }) => void;
        interiorViews: Record<string, { eye: [number, number, number]; target: [number, number, number] }>;
      };
      const THREE_NS = await import('three');
      car.applyVisibility({ interior: true });
      car.root.updateMatrixWorld(true);

      const interiorRoot = car.root.getObjectByName('yangwang-v800-interior');
      expect(interiorRoot, '应有 yangwang-v800-interior 子树').toBeTruthy();

      /** 收集「材质 id → 是否仍可见」，逐材质去重（与修复同口径）。 */
      const matById = new Map<string, boolean[]>();
      let visibleMeshes = 0;
      interiorRoot!.traverse((o) => {
        const mesh = o as unknown as import('three').Mesh;
        if (!mesh.isMesh) return;
        const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const anyVisible = arr.some((mt) => !!mt && mt.visible !== false);
        let ancVis = true;
        let p = mesh.parent as import('three').Object3D | null;
        while (p && p !== interiorRoot) {
          if (!p.visible) ancVis = false;
          p = p.parent;
        }
        if (!mesh.visible || !ancVis || !anyVisible) return;
        visibleMeshes++;
        for (const mt of arr) {
          if (!mt) continue;
          const id = (mt.userData as { sculptMaterial?: { id?: string } })?.sculptMaterial?.id ?? null;
          const list = matById.get(id ?? '(id-less)') ?? [];
          list.push(true);
          matById.set(id ?? '(id-less)', list);
        }
      });

      // ① 外壳材质必须全灭（它们是「米黄色光面隔板」的本体）
      const culled = [
        'glass-clear', 'glass-dark', 'paint-upper', 'paint-lower', 'tire',
        'wheel-alloy', 'chrome', 'plate', 'matte-black'
      ];
      for (const id of culled) {
        expect(
          !matById.has(id),
          `车内态不应出现任何可见的外壳材质实例：${id}`
        ).toBe(true);
      }
      // ② 内饰材质必须在（否则车内变空壳 = 修复过狠）
      for (const id of ['carpet', 'leather-dark', 'screen-ui']) {
        expect(matById.has(id), `车内态应保留内饰材质 ${id}`).toBe(true);
      }
      // ③ 量级护栏：裁切后车内可见 mesh 应明显低于「外壳件全留」的 133
      expect(visibleMeshes).toBeLessThanOrEqual(45);
      expect(visibleMeshes).toBeGreaterThanOrEqual(20);

      // ④ 主驾眼位 7×7 方向栅格：不得有任何一条射线的首命中落在外壳材质上
      const eyeW = new THREE_NS.Vector3(
        -car.interiorViews.driver.eye[0],
        car.interiorViews.driver.eye[1],
        -car.interiorViews.driver.eye[2]
      );
      const tgtW = new THREE_NS.Vector3(
        -car.interiorViews.driver.target[0],
        car.interiorViews.driver.target[1],
        -car.interiorViews.driver.target[2]
      );
      const fwd = tgtW.clone().sub(eyeW).normalize();
      const right = new THREE_NS.Vector3().crossVectors(new THREE_NS.Vector3(0, 1, 0), fwd).normalize();
      const up = new THREE_NS.Vector3().crossVectors(fwd, right).normalize();
      const rc = new THREE_NS.Raycaster();
      rc.near = 0;
      rc.far = 30;
      let hits = 0;
      for (let iy = 0; iy < 7; iy++) {
        for (let ix = 0; ix < 7; ix++) {
          const pitch = ((iy + 0.5) / 7) * 2 * 0.3 - 0.3;
          const yaw = -(((ix + 0.5) / 7) * 2 - 1) * 0.5;
          const d = fwd
            .clone()
            .add(right.clone().multiplyScalar(Math.sin(yaw) * Math.cos(pitch)))
            .add(up.clone().multiplyScalar(Math.sin(pitch)))
            .normalize();
          rc.set(eyeW, d);
          const hs = rc.intersectObject(interiorRoot!, true);
          // three 的 Raycaster 不判 material.visible ⇒ 手动跳过被裁切的命中
          const first = hs.find((h) => {
            const arr = Array.isArray(h.object.material) ? h.object.material : [h.object.material];
            return arr.some((mt) => !!mt && mt.visible !== false);
          });
          if (!first) continue;
          hits++;
          const arr = Array.isArray(first.object.material) ? first.object.material : [first.object.material];
          const ids = arr.map(
            (mt) => (mt.userData as { sculptMaterial?: { id?: string } })?.sculptMaterial?.id ?? null
          );
          expect(
            !ids.some((id) => id === 'glass-clear' || id === 'glass-dark' || id === 'paint-upper' || id === 'paint-lower'),
            `主驾视线第 ${hits} 条首命中不得落在外壳材质上（实测 ${first.object.name} / ${ids.join(',')}）`
          ).toBe(true);
        }
      }
      // 修复前 28/49 条被风挡吃掉；修复后应仅剩仪表台 / 三联屏 / 方向盘等内饰件
      expect(hits, '主驾眼位应有部分射线命中内饰件').toBeGreaterThan(0);

      // ⑤ 车外 ↔ 车内往返：裁切必须**幂等**（V800 的空状态表不会把外壳材质"恢复"回来，
      //    本车的裁切也不应因切换而复活）。这是「切一次机位就穿帮」这类回归的护栏。
      const scanVisibleMatIds = (): Set<string | null> => {
        const ids = new Set<string | null>();
        interiorRoot!.traverse((o) => {
          const mesh = o as unknown as import('three').Mesh;
          if (!mesh.isMesh) return;
          const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mt of arr) {
            if (!mt || mt.visible === false) continue;
            ids.add((mt.userData as { sculptMaterial?: { id?: string } })?.sculptMaterial?.id ?? null);
          }
        });
        return ids;
      };
      expect(scanVisibleMatIds().has('glass-clear')).toBe(false);
      car.applyVisibility({ interior: false });
      expect(interiorRoot!.visible, '车外态应整体隐藏内饰子树').toBe(false);
      car.applyVisibility({ interior: true });
      expect(interiorRoot!.visible, '车内态应恢复内饰子树').toBe(true);
      const after = scanVisibleMatIds();
      expect(after.has('glass-clear'), '往返切换后 glass-clear 不得复活').toBe(false);
      expect(after.has('paint-upper'), '往返切换后 paint-upper 不得复活').toBe(false);
      expect(after.has('screen-ui'), '往返切换后内饰屏材质必须在').toBe(true);
    } finally {
      restore();
    }
  }, 60000);
});
