/**
 * R49 Phase 2b · 灯组视觉参数契约（源码字符串断言，与 r48_lamp.test.ts 同风格）。
 *
 * 数值来源：`.qa/r49/PHASE2B_DIAG.md` §三（射线实测）+ 工单美术口径。
 * 运行时装配路径（外部壳异步、canvas atlas）在 Node 下无法实例化，
 * 故钉**参数不变量**；像素级验收见 PHASE2B_DIAG.md §四/§六（口径待固化）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string): string =>
  readFileSync(resolve(__dirname, '..', rel), 'utf-8').replace(/\r\n/g, '\n');
const SHELL = 'src/model/external/ExternalShell.ts';

describe('R49-P2b · 尾灯盖板几何（射线实测）', () => {
  it('盖板外移到 body 最外层 +10mm，且高度 0.34 / 中心 1.015', () => {
    const s = src(SHELL);
    // 主因：R48 的 2.505 比 body 世界最外层 (bodyBBox.max[2]*scale) 深 14.4mm
    expect(s).toContain('const coverY = r49Hole ? 1.015 : 0.240 * s;');
    expect(s).toContain('const coverH = r49Hole ? 0.34 : 0.20;');
    // 盖板 z 改为**按灯组外推后的运行时实测 max z 反推**（manifest×scale 比 Live 小 9.7mm，作废）
    // R49-P2c 几何回退 v1：bodyMaxZ 用 manifest×scale，盖板 z=-(bodyMaxZ+0.010)
    expect(s).toContain('const bodyMaxZ = (manifest.bodyBBox?.max?.[2] ?? 0.5828) * s;');
    expect(s).toContain('housing.position.set(0, coverY, r49Hole ? -(bodyMaxZ + 0.010) : -2.505);');
    // 次因：R48 的 0.20m 只覆盖 y∈[0.9375,1.1375]，实测白块下界 y=0.893
    expect(s).toContain('const coverH = r49Hole ? 0.34 : 0.20;');
    expect(s).toContain('const coverY = r49Hole ? 1.015 : 0.240 * s;');
    expect(s).toContain('new THREE.PlaneGeometry(2.02, coverH)');
  });

  it('R49 盖板默认关闭（回归 R48 观感），#r49hole=on 才启用；R48 语义 #r48hole=off 未被破坏', () => {
    const s = src(SHELL);
    // ⚠ 收口裁决：默认值从 true 翻为 false——用 r49hole=on 显式启用，而非默认开 + r49hole=off 关
    expect(s).toContain("const r49Hole = /(?:^|[#&])r49hole=on/i.test(");
    expect(s).toContain('r48hole=off');
  });
});

describe('R49-P2b · 红细带 / 下缘反光条', () => {
  it('红细带 0.055→0.018、色 #5A1E1E、emissiveIntensity 0.35、独立材质', () => {
    const s = src(SHELL);
    expect(s).toContain('new THREE.PlaneGeometry(1.86, r49Hole ? 0.018 : 0.055)');
    expect(s).toContain('emissiveIntensity: 0.35,');
    expect(s).toContain('emissive: new THREE.Color(0x5a1e1e),');
    expect(s).toContain("g.fillStyle = '#5a6068';")
    expect(s).toContain("g.fillStyle = '#9c2424';")
    // 必须与 lampRearMat 拆开（否则改色会把灯组一起压暗）
    expect(s).toContain('r49BandMat = r49Hole');
  });

  it('下缘红反光条：本轮**下线**（headless 下 alpha 采样异常会整块白），代码保留待真机复核', () => {
    const s = src(SHELL);
    // 实测 probe_v4/v5：该件让 ROI 纯白 273 → 3,383 px（面积≈整块平面）⇒ 必须下线
    expect(s).toContain('本轮下线');
    // atlas 生成器保留（export 以便后续真机复核后重新接线）
    expect(s).toContain('export function makeR7LowerReflectorAtlas');
    // 不再有 wire-up（避免误启用）
    expect(s).not.toContain("refl.name = 'lamp_rear_reflector';");
  });

  it('盖板基色恒为深墨（不依赖 map 是否成功，防整块白板）', () => {
    const s = src(SHELL);
    expect(s).toContain('color: r49Hole ? 0x141418 : 0x101014,');
    expect(s).toContain('roughness: r49Hole ? 0.70 : 0.5,');
    expect(s).toContain('metalness: r49Hole ? 0.06 : 0.1,');
    // 盖板按实测车尾宽度收窄（溜背，避免左右悬空）
// 材质已按实测从 metalness 0.35 回调（平板全反射会被 bloom 吹白）
    expect(s).toContain('metalness: r49Hole ? 0.06 : 0.1,');
    expect(s).toContain('envMapIntensity: r49Hole ? 0.45 : 1,');
  });

  it('字标/灯组内部分段走 atlas（同材质零额外 DC）', () => {
    const s = src(SHELL);
    expect(s).toContain('makeR7RearBandAtlas');
    expect(s).toContain('map: r49Hole ? (makeR7RearBandAtlas() ?? undefined) : undefined');
    expect(s).toContain('L U X E E D');
  });

  it('新增材质/贴图全部进入 dispose 账本', () => {
    const s = src(SHELL);
    expect(s).toContain('const r49DecorMats: THREE.Material[] = [];');
    expect(s).toContain('const r49DecorTex: THREE.Texture[] = [];');
    expect(s).toContain('for (const t of r49DecorTex) t.dispose();');
  });
});

describe('R49-P2b · 红线守卫', () => {
  it('不给 glass/lamp 打开 castShadow，且未回退 transmission', () => {
    const shell = src(SHELL);
    // R44-6 起 glass/lamp 的 castShadow=false 在**两台适配器**的挂载块里再关一次
    for (const f of ['src/model/V800Adapter.ts', 'src/model/R7Adapter.ts']) {
      expect(src(f)).toContain('sm.castShadow = false;');
    }
    // 玻璃仍走 transparent alpha（R47），未在本文件引入 transmission（R12b 已下线）
    expect(shell).not.toContain('transmission:');
  });

  it('红细带/反光条不参与阴影（renderOrder 装饰件）', () => {
    const s = src(SHELL);
    const bandBlock = s.slice(s.indexOf("band.name = 'lamp_rear_band'"), s.indexOf("band.name = 'lamp_rear_band'") + 600);
    expect(bandBlock).toContain('band.castShadow = false;');
    expect(bandBlock).toContain('band.renderOrder = 2;');
  });
});
