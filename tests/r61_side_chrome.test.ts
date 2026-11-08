/**
 * R61 · 车身侧面贯穿镀铬条护栏（修「侧面缺窗台线/下裙线镀铬条」）
 *
 * 背景（R61 视觉主理 .qa/r61 + tools/r61_glb_probe.mjs 量化 body 侧面 x(z)）：
 *  V800 官图 064 / R7 侧视均有一条横贯车长的亮银镀铬饰条（窗台线），部分车型下裙还有
 *  第二条；当前渲染两侧均缺 ⇒ 侧面层次单薄、缺失豪华 MPV 标志特征。R61 复刻 R54 程序化
 *  ribbon 模式：双线（belt/skirt）× 双侧（左/右）合并为单 mesh 挂 bodyMesh，DC +1/车。
 *
 * 本护栏钉结构不变量（源码结构，非建模渲染）；真实观感由 Phase 3 审查线 A/B 逐位比对。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shell = src('src/model/external/ExternalShell.ts');

describe('R61 · 侧面贯穿镀铬条开关与剖面常量', () => {
  it('R61_SIDE_ON 开关存在，#r61side=off 逐位回滚', () => {
    expect(shell).toContain("export const R61_SIDE_ON = !r51HookOff('r61side');");
    expect(shell).toMatch(/r61side=off/);
  });

  it('两套窗台线剖面常量存在且非空（V800/R7 × belt）', () => {
    for (const name of ['R61_V800_BELT', 'R61_R7_BELT']) {
      const re = new RegExp(`const ${name}: ReadonlyArray<readonly \\[number, number\\]> = \\[`);
      expect(shell).toMatch(re);
      const start = shell.indexOf(`${name}:`);
      const block = shell.slice(start, shell.indexOf('];', start));
      const rows = (block.match(/\d+\.\d+,/g) ?? []).length;
      expect(rows).toBeGreaterThan(20); // 剖面须沿车长密集采样
    }
  });

  it('剖面 z 升序、x 为车身侧面外凸量（>0）', () => {
    const block = shell.slice(
      shell.indexOf('const R61_V800_BELT'),
      shell.indexOf('];', shell.indexOf('const R61_V800_BELT'))
    );
    const pairs = [...block.matchAll(/\[([+-]?[\d.]+),\s*([\d.]+)\]/g)].map((m) => [
      parseFloat(m[1]),
      parseFloat(m[2])
    ]);
    expect(pairs.length).toBeGreaterThan(20);
    for (let i = 1; i < pairs.length; i += 1) {
      expect(pairs[i][0]).toBeGreaterThan(pairs[i - 1][0]); // z 升序
      expect(pairs[i][1]).toBeGreaterThan(0); // x 为正（车身右侧外凸）
    }
  });
});

describe('R61 · 构建与接线（双侧合并为单 mesh，DC +1/车）', () => {
  it('r61BuildSideTrim 定义：合并 2 段 ribbon（右+左）为单 mesh 挂 bodyMesh', () => {
    expect(shell).toMatch(/function r61BuildSideTrim\(/);
    const fn = shell.slice(shell.indexOf('function r61BuildSideTrim('), shell.indexOf('/* ══ R55'));
    // 右 + 左（flip）共 2 段
    expect(fn).toMatch(/r61BuildSideRibbon\(beltProf, BELT_Y, H, DX, OFF\)/); // 右
    expect(fn).toMatch(/r61BuildSideRibbon\(beltProf\.map\(flip\), BELT_Y, H, DX, OFF\)/); // 左
    expect(fn).toContain('const merged = mergeSafe(geos);');
    expect(fn).toContain('bodyMesh.add(mesh);');
    expect(fn).toContain('outMats.push(chromeMat);');
    expect(fn).toContain('outGeos.push(merged);');
    expect(fn).toContain('side: THREE.DoubleSide'); // 兜底绕向误差
  });

  it('r61BuildSideRibbon 沿 (z,x) 剖面挤出闭合四边形带', () => {
    const fn = shell.slice(shell.indexOf('function r61BuildSideRibbon('), shell.indexOf('function r61BuildSideTrim('));
    expect(fn).toContain('g.setIndex(idx);');
    expect(fn).toContain('g.computeVertexNormals();');
    // 末端双端帽（−Z / +Z）
    expect(fn).toMatch(/idx\.push\(1, 0, 2, 1, 2, 3\)/);
  });

  it('构建流程接线：r61BuildSideTrim 被调用（DC +1/车）', () => {
    expect(shell).toContain('r61BuildSideTrim(bodyMesh, car, r61SideMats, r61SideGeos);');
  });

  it('释放接线：cleanup 释放 r61SideMats / r61SideGeos', () => {
    const anchor = 'for (const g of r58RearGeos) g.dispose();';
    const end = 'lampAtlasTex?.dispose();';
    const clean = shell.slice(shell.indexOf(anchor), shell.indexOf(end, shell.indexOf(anchor)));
    expect(clean).toContain('for (const m of r61SideMats) m.dispose();');
    expect(clean).toContain('for (const g of r61SideGeos) g.dispose();');
  });
});
