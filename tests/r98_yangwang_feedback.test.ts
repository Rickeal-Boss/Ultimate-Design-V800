/**
 * R98 · 仰望（鼎曜）高精度 GLB 加载反馈链路护栏
 *
 * 症状（用户真机）：
 *  1) 统一「停止下载高精度模型」按钮对仰望无效，高精度 GLB 照样下载/挂树；
 *  2) 40MB 单 GLB 全程无进度提示（旧代码 loader.load 第 3 参传 undefined）；
 *  3) GLB 失败静默回退香槟金盒子，台账只有 failed、无 error、HUD 零文案；
 *  4) 偏好关闭/取消态下仍下载 GLB，加载门读不到 yangwang 台账而卡住（「无法进入」）。
 *
 * 根因：YangwangAdapter.ts 直接 `GLTFLoader.load` 单 GLB，绕过 config/highDetail 的
 *  isHighDetailEnabled / isShellLoadCancelled / onShellCancel 发布订阅与 ExternalShell 的
 *  shellHud / shellHudProgress 统一 HUD。
 *
 * 本护栏用**运行时真构造适配器 + 伪 GLTFLoader.load 捕获回调**，逐条钉死：
 * 门禁零下载 / 加载中取消不挂树 / onProgress 进度+台账 / 失败可读文案 / 终态注销订阅；
 * 另以源码字符串钉死「无 window 零网络」隔离。
 *
 * ⚠ 不读 .qa / 不跑 git / 不渲染；只 import 真模块 + 最小 DOM shim。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';

const YW_SRC = readFileSync(new URL('../src/model/YangwangAdapter.ts', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

type Ledger = { state?: string; bytes?: number; total?: number; error?: string };
type LoadCall = {
  url: string;
  onLoad: (gltf: { scene: THREE.Object3D }) => void;
  onProgress: (e: { loaded: number; total: number }) => void;
  onError: (e: unknown) => void;
};

let restoreEnv: () => void = () => {};

const ledger = (): Ledger | undefined =>
  (globalThis as unknown as { window?: { __r44Shell?: Record<string, Ledger> } }).window
    ?.__r44Shell?.yangwang;

const hudText = (): string | null =>
  ((globalThis as unknown as {
    document?: { getElementById?: (id: string) => { textContent: string } | null };
  }).document?.getElementById?.('r44-shell-hud') ?? null)?.textContent ?? null;

/** 最小 DOM / localStorage shim：让 config/quality 模块求值期可读 window.devicePixelRatio。 */
function installShim(): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const REAL = {
    window: g.window,
    document: g.document,
    localStorage: g.localStorage
  };

  const grad = () => ({ addColorStop() {} });
  const imageData = (w: number, h: number) => ({
    data: new Uint8ClampedArray(Math.max(1, w * h) * 4),
    width: Math.max(1, w),
    height: Math.max(1, h)
  });
  const ctx2d = () =>
    new Proxy(
      {
        canvas: null as unknown,
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        font: '10px sans-serif',
        globalAlpha: 1,
        measureText: () => ({ width: 0 }),
        getLineDash: () => [],
        createLinearGradient: grad,
        createRadialGradient: grad,
        createConicGradient: grad,
        createPattern: () => null,
        createImageData: (w: number, h: number) => imageData(w, h),
        getImageData: (_x: number, _y: number, w: number, h: number) => imageData(w, h)
      } as Record<string | symbol, unknown>,
      {
        get(t, k) {
          if (k in t) return t[k];
          return typeof k === 'symbol' ? undefined : () => {};
        },
        set(t, k, v) {
          t[k] = v;
          return true;
        }
      }
    );
  const makeCanvas = () => {
    const canvas = {
      width: 8,
      height: 8,
      style: {},
      getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
      toDataURL: () => 'data:image/gif;base64,',
      addEventListener() {},
      removeEventListener() {}
    };
    return canvas;
  };

  // HUD 节点（shellHud 创建 → body.appendChild 注册；el.remove() 注销）
  const nodes = new Map<string, { id: string; style: Record<string, string>; textContent: string; remove(): void }>();
  g.document = {
    createElement(tag: string) {
      if (tag === 'canvas') return makeCanvas();
      const el = {
        id: '',
        style: {} as Record<string, string>,
        textContent: '',
        remove() {
          nodes.delete(el.id);
        }
      };
      return el;
    },
    createTextNode: () => ({}),
    documentElement: { style: {} },
    body: {
      appendChild(el: { id: string }) {
        nodes.set(el.id, el as never);
      },
      removeChild(el: { id: string }) {
        nodes.delete(el.id);
      }
    },
    head: { appendChild() {} },
    getElementById(id: string) {
      return nodes.get(id) ?? null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createEvent: () => ({ initEvent() {} })
  };
  g.window = {
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 720,
    location: { hash: '', href: '' },
    addEventListener() {},
    removeEventListener() {}
  };
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear()
  };

  return () => {
    for (const k of Object.keys(REAL)) {
      if (REAL[k] === undefined) delete g[k];
      else g[k] = REAL[k];
    }
  };
}

type Car = { root: THREE.Object3D; shellReady: boolean; dispose(): void };

/**
 * 重置 highDetail 模块级取消态 + 一次载入 highDetail / YangwangAdapter 真模块并接管
 * GLTFLoader.load。返回同一个模块图里的 hw（取消信号真源）与工厂，确保测试发布的
 * cancel 与本车订阅的是同一份发布订阅实例。
 */
async function freshModules() {
  await vi.resetModules();
  const hw = await import('../src/config/highDetail');
  const { createYangwangCarAdapter } = await import('../src/model/YangwangAdapter');
  const calls: LoadCall[] = [];
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((
    url: string,
    onLoad: LoadCall['onLoad'],
    onProgress?: (e: ProgressEvent) => void,
    onError?: (e: unknown) => void
  ) => {
    calls.push({
      url: String(url),
      onLoad,
      onProgress: onProgress as LoadCall['onProgress'] ?? (() => {}),
      onError: onError ?? (() => {})
    });
  });
  const build = (): Car => createYangwangCarAdapter('high') as unknown as Car;
  return { hw, build, calls };
}

/** 造一个带 yangwang-body 的伪 GLB scene，并提供 dispose 探针。 */
function fakeGltf(): { scene: THREE.Group; body: THREE.Mesh; geometryDisposed: () => boolean } {
  const scene = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  body.name = 'yangwang-body';
  scene.add(body);
  const geo = body.geometry;
  return { scene, body, geometryDisposed: () => (geo.dispose as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length === 1 };
}

beforeEach(() => {
  restoreEnv = installShim();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreEnv();
  restoreEnv = () => {};
});

describe('R98 · 仰望高精度 GLB 加载反馈链路', () => {
  it('无 window 时零网络：GLTFLoader.load 一次都不调用', async () => {
    await vi.resetModules();
    const { createYangwangCarAdapter } = await import('../src/model/YangwangAdapter');
    const spy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});
    // 与 r94 同款：模块求值期需 window（quality.ts），构造期撤掉 ⇒ 关闭 GLB 分支。
    delete (globalThis as unknown as { window?: unknown }).window;
    createYangwangCarAdapter('high');
    expect(spy).not.toHaveBeenCalled();
    expect(YW_SRC).toMatch(/if \(typeof window !== 'undefined'\) \{[\s\S]*loader\.load\(/);
  }, 20000); // 全量 58 文件并行时本例首次动态 import 需重建 V800 工厂，单跑 3s / 全量 7s

  it('偏好关闭 ⇒ 零下载、台账 cancelled(40MB 口径)、fallback 保留', async () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem('v800.highDetail', 'off');
    const { build, calls } = await freshModules();
    const car = build();
    expect(calls).toHaveLength(0);
    expect(ledger()?.state).toBe('cancelled');
    expect(ledger()?.total).toBe(40 * 1024 * 1024);
    expect(ledger()?.bytes).toBe(0);
    expect(car.shellReady).toBe(false);
    expect(car.root.getObjectByName('yangwang-fallback-body')?.visible).toBe(true);
    expect(hudText()).toContain('已按设置使用默认车模');
  });

  it('已从 UI 取消（模块级标记）⇒ 零下载、台账 cancelled 带原因', async () => {
    const { hw, build, calls } = await freshModules();
    hw.cancelExternalShellLoad('user');
    build();
    expect(calls).toHaveLength(0);
    expect(ledger()?.state).toBe('cancelled');
    expect(ledger()?.error).toContain('user');
  });

  it('加载中点停止 ⇒ 台账 cancelled、onLoad 迟到直接 dispose 不挂树、fallback 保留', async () => {
    vi.useFakeTimers();
    const { hw, build, calls } = await freshModules();
    const car = build();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('yangwang.glb');
    expect(ledger()?.state).toBe('loading');

    // onProgress：HUD 进度 + 台账 bytes/total
    calls[0].onProgress({ loaded: 12 * 1024 * 1024, total: 40 * 1024 * 1024 });
    expect(ledger()?.bytes).toBe(12 * 1024 * 1024);
    expect(ledger()?.total).toBe(40 * 1024 * 1024);
    vi.advanceTimersByTime(220);
    expect(hudText()).toContain('12.0 MB');
    expect(hudText()).toContain('40 MB');

    // 用户在加载中停止
    hw.cancelExternalShellLoad('user');
    expect(ledger()?.state).toBe('cancelled');
    expect(ledger()?.error).toContain('cancelled by user');
    expect(hudText()).toContain('已停止下载');

    // onLoad 迟到：不挂树、GLB 被 dispose、fallback 仍在
    const g = fakeGltf();
    const disposeSpy = vi.spyOn(g.body.geometry, 'dispose');
    calls[0].onLoad({ scene: g.scene });
    expect(disposeSpy).toHaveBeenCalled();
    expect(car.root.getObjectByName('yangwang-body')).toBeUndefined();
    expect(car.shellReady).toBe(false);
    expect(car.root.getObjectByName('yangwang-fallback-body')?.visible).toBe(true);
  });

  it('成功加载 ⇒ ready + bytes/total、挂树、HUD，终态注销订阅', async () => {
    const { hw, build, calls } = await freshModules();
    const car = build();
    calls[0].onProgress({ loaded: 40 * 1024 * 1024, total: 40 * 1024 * 1024 });
    const g = fakeGltf();
    calls[0].onLoad({ scene: g.scene });

    expect(ledger()?.state).toBe('ready');
    expect(ledger()?.bytes).toBe(40 * 1024 * 1024);
    expect(ledger()?.total).toBe(40 * 1024 * 1024);
    expect(car.shellReady).toBe(true);
    const mounted = car.root.getObjectByName('yangwang-body');
    expect(mounted).not.toBeNull();
    expect((mounted?.userData as { r44External?: boolean } | undefined)?.r44External).toBe(true);
    expect(car.root.getObjectByName('yangwang-fallback-body')?.visible).toBe(false);
    expect(hudText()).toContain('已就绪');

    // 订阅已在终态注销：再发布一次取消不得把 ready 改写成 cancelled
    hw.cancelExternalShellLoad('user');
    expect(ledger()?.state).toBe('ready');
  });

  it('R143-D 成功加载（默认香槟金）⇒ 车身材质镜面反射降载（specularIntensity 0.3 / roughness 0.5）', async () => {
    const { build, calls } = await freshModules();
    const car = build();
    calls[0].onProgress({ loaded: 40 * 1024 * 1024, total: 40 * 1024 * 1024 });
    // 真车 Material.001 是 MeshPhysicalMaterial（KHR_materials_specular）；用 Physical 伪材
    // 质确保 tuneYangwangBodySpecular 的 isMeshPhysicalMaterial 判词命中。
    const scene = new THREE.Group();
    const bodyMat = new THREE.MeshPhysicalMaterial();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), bodyMat);
    body.name = 'yangwang-body';
    scene.add(body);
    calls[0].onLoad({ scene });

    expect(car.shellReady).toBe(true);
    expect(bodyMat.specularIntensity).toBe(0.3);
    expect(bodyMat.roughness).toBe(0.5);
    // 兜底车身隐藏（真 GLB 已挂树）
    expect(car.root.getObjectByName('yangwang-fallback-body')?.visible).toBe(false);
  });

  it('失败 ⇒ failed + 可读 error、HUD err 文案、fallback 保留、终态注销', async () => {
    const { hw, build, calls } = await freshModules();
    const car = build();
    calls[0].onProgress({ loaded: 3 * 1024 * 1024, total: 40 * 1024 * 1024 });
    calls[0].onError(new Error('HTTP 404 yangwang.glb'));

    expect(ledger()?.state).toBe('failed');
    expect(ledger()?.error).toContain('HTTP 404 yangwang.glb');
    expect(ledger()?.bytes).toBe(3 * 1024 * 1024);    expect(hudText()).toContain('加载失败');
    expect(hudText()).toContain('HTTP 404');
    expect(car.shellReady).toBe(false);
    expect(car.root.getObjectByName('yangwang-fallback-body')?.visible).toBe(true);

    // 终态注销：再发布取消不得把 failed 改写
    hw.cancelExternalShellLoad('user');
    expect(ledger()?.state).toBe('failed');
  });
});
