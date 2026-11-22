/**
 * R137 · 高精度 GLB 按 GPU 类别默认门控（数据驱动）→ **R141 撤销（用户指令：不回落程序化）**。
 *
 * 背景（本机 Arc iGPU + 生产 #perfhud 实测）：高精度外部壳 `body 966,484 + 4 轮 303,521
 * = 1,270,005 tri`，整帧 `tris 1,503,898`；`#highDetail=off` 对照 `tris 145,900` ⇒
 * **车模 GLB 是核显几何成本主因（8.7×），非建筑**。R137 曾处方：核显默认回落程序化车模
 * （82k）。**R141（用户裁决）：默认一律不回落程序化模型，GPU 类别无关**，显式
 * `#highDetail=off` / localStorage='off' 仍让位。
 *
 * 断言焦点（优先级不可倒置）：`URL hash > localStorage > 恒 on（GPU 无关）`。
 * highDetail.ts 是 Node-safe 配置模块（`import type { GpuClass }` 被 TS 擦除，不求值 quality），
 * 故只需 shim `window.location.hash` + `localStorage`，无需完整 DOM/quality shim。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isHighDetailEnabled,
  setActiveGpuClass,
  getActiveGpuClass
} from '../src/config/highDetail';

function installShim(): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const REAL = { window: g.window, localStorage: g.localStorage };
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, v);
    }
  };
  const win = { location: { hash: '' } } as unknown as Window;
  g.window = win;
  g.localStorage = storage;
  return () => {
    g.window = REAL.window;
    g.localStorage = REAL.localStorage;
  };
}

let restore: () => void;

beforeEach(() => {
  restore = installShim();
  // 复位模块态：无 hash、无存储、GPU 未知（默认行为 = 高精度开）
  setActiveGpuClass('unknown');
});

afterEach(() => {
  restore();
  setActiveGpuClass('unknown');
});

describe('R141 默认不回落程序化（无 hash / 无存储，GPU 无关）', () => {
  it('核显默认保持高精度（on，R141 不回落）', () => {
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(true);
  });

  it('离散独显默认保持高精度（on）', () => {
    setActiveGpuClass('discrete');
    expect(isHighDetailEnabled()).toBe(true);
  });

  it('未知 GPU 默认保持高精度（on）', () => {
    setActiveGpuClass('unknown');
    expect(isHighDetailEnabled()).toBe(true);
  });

  it('软件渲染默认保持高精度（on，R141 不回落）', () => {
    setActiveGpuClass('software');
    expect(isHighDetailEnabled()).toBe(true);
  });
});

describe('R137 显式 #highDetail 覆盖（优先级最高）', () => {
  it('核显 + #highDetail=on ⇒ 强制高精度（显式选择可覆盖 GPU 感知默认）', () => {
    (window as unknown as { location: { hash: string } }).location.hash = '#highDetail=on';
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(true);
  });

  it('离散 + #highDetail=off ⇒ 回落程序化（显式关闭优先）', () => {
    (window as unknown as { location: { hash: string } }).location.hash = '#highDetail=off';
    setActiveGpuClass('discrete');
    expect(isHighDetailEnabled()).toBe(false);
  });
});

describe('R137 localStorage 偏好覆盖（次优先）', () => {
  it("核显 + localStorage='off' ⇒ 程序化", () => {
    localStorage.setItem('v800.highDetail', 'off');
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(false);
  });

  it("核显 + localStorage='on' ⇒ 强制高精度（本地显式选择）", () => {
    localStorage.setItem('v800.highDetail', 'on');
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(true);
  });
});

describe('R137 优先级倒置守卫', () => {
  it('hash 覆盖 localStorage（hash 优先）', () => {
    localStorage.setItem('v800.highDetail', 'off');
    (window as unknown as { location: { hash: string } }).location.hash = '#highDetail=on';
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(true);
  });

  it('localStorage 覆盖 GPU 感知默认（存储优先于默认）', () => {
    localStorage.setItem('v800.highDetail', 'on');
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(true);
  });
});

describe('R137 setActiveGpuClass / getActiveGpuClass', () => {
  it('默认 unknown（未注入）', () => {
    setActiveGpuClass('unknown');
    expect(getActiveGpuClass()).toBe('unknown');
  });

  it('注入后可读回', () => {
    setActiveGpuClass('integrated');
    expect(getActiveGpuClass()).toBe('integrated');
    setActiveGpuClass('discrete');
    expect(getActiveGpuClass()).toBe('discrete');
  });
});
