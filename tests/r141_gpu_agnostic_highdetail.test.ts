/**
 * R141 · 用户指令：默认不回落程序化模型（GPU 无关）。
 *
 * 背景（V800_R110-R138 深度审查 §4 头号发现 + 用户裁决）：R137 曾让核显/软渲默认回落
 * 程序化车模（V800 黄盒 82k tri / R7 绿板 31k / 仰望 588 tri 金盒无车形），而 40+ 轮外观
 * 验收全部只在 GLB 路径验过，回退路径从未打磨。用户明确：**默认不要回落程序化模型，
 * 无论显卡性能如何，优先保留完整观感**。
 *
 * 本测试钉死 R141 行为：
 *  - 缺省（无 hash / 无存储）一律高精度 = true，GPU 类别无关（integrated / software /
 *    discrete / unknown 全 true）。
 *  - 显式 `#highDetail=off` / localStorage='off' 仍让位（显式选择优先，QA A/B 构造回退态）。
 *  - 显式 `#highDetail=on` / localStorage='on' 恒强制高精度。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isHighDetailEnabled, setActiveGpuClass } from '../src/config/highDetail';

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
  setActiveGpuClass('unknown');
});

afterEach(() => {
  restore();
  setActiveGpuClass('unknown');
});

describe('R141 缺省默认恒高精度（GPU 无关，无 hash / 无存储）', () => {
  it('核显（integrated）默认保持高精度，不回落', () => {
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(true);
  });

  it('软件渲染（software）默认保持高精度，不回落', () => {
    setActiveGpuClass('software');
    expect(isHighDetailEnabled()).toBe(true);
  });

  it('离散（discrete）默认保持高精度', () => {
    setActiveGpuClass('discrete');
    expect(isHighDetailEnabled()).toBe(true);
  });

  it('未知（unknown）默认保持高精度', () => {
    setActiveGpuClass('unknown');
    expect(isHighDetailEnabled()).toBe(true);
  });
});

describe('R141 显式让位仍生效（显式选择优先）', () => {
  it('#highDetail=off 覆盖默认（核显）', () => {
    (window as unknown as { location: { hash: string } }).location.hash = '#highDetail=off';
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(false);
  });

  it('#highDetail=on 恒强制（核显）', () => {
    (window as unknown as { location: { hash: string } }).location.hash = '#highDetail=on';
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(true);
  });

  it("localStorage='off' 让位（离散）", () => {
    localStorage.setItem('v800.highDetail', 'off');
    setActiveGpuClass('discrete');
    expect(isHighDetailEnabled()).toBe(false);
  });

  it("localStorage='on' 恒强制（核显）", () => {
    localStorage.setItem('v800.highDetail', 'on');
    setActiveGpuClass('integrated');
    expect(isHighDetailEnabled()).toBe(true);
  });
});
