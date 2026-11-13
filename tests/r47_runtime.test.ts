/**
 * R47 运行时契约测试。
 *
 * 覆盖本轮三条用户点名需求的**可回归不变量**：
 *  ① 动态模糊开关默认关闭（用户明确「默认不开」）；
 *  ② 车轮内外侧方向修复（轮几何绕 Y 刚性旋转 π 与 body rotY(π) 对齐）；
 *  ③ 内外模透视 / cabin 态外模保留（玻璃不透明度接口 + 不再整壳隐藏）。
 * 另锁 R47 性能线：SpeedBlur shader 零成本 early-out 必须存在。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isMotionBlurEnabled,
  resetMotionBlurForTest,
  setMotionBlurEnabled
} from '../src/config/motionBlur';

const src = (rel: string): string =>
  readFileSync(resolve(__dirname, '..', rel), 'utf-8');

describe('R47 · 动态模糊开关（默认关闭）', () => {
  beforeEach(() => {
    try {
      localStorage.removeItem('v800.motionBlur');
    } catch {
      /* Node 环境无 localStorage，正常 */
    }
    resetMotionBlurForTest();
  });

  it('缺省为关闭（用户口径：默认不开）', () => {
    expect(isMotionBlurEnabled()).toBe(false);
  });

  it('打开后即时生效，复位后回到关闭', () => {
    setMotionBlurEnabled(true);
    expect(isMotionBlurEnabled()).toBe(true);
    setMotionBlurEnabled(false);
    expect(isMotionBlurEnabled()).toBe(false);
  });

  it('首次读取后走模块级缓存（每帧调用不触碰存储）', () => {
    expect(isMotionBlurEnabled()).toBe(false);
    // 外部绕过 setter 直接改存储，缓存仍应生效（Game 每帧 2 次调用的语义）
    try {
      localStorage.setItem('v800.motionBlur', 'on');
    } catch {
      /* Node 下跳过这半条 */
    }
    expect(isMotionBlurEnabled()).toBe(false);
    resetMotionBlurForTest();
  });

  it('关闭态严格写 0 且传 dt=0 / smooth=false（无滞后余晖）', () => {
    const game = src('src/core/Game.ts');
    expect(game).toContain('motionBlurOn ? dt : 0');
    expect(game).toContain('motionBlurOnFree ? dt : 0');
    expect(game).toContain('const freeBlur = !motionBlurOnFree ? 0 : R46_BLUR_V2');
    expect(game).toContain('if (motionBlurOn && pedaling');
  });

  it('菜单提供开关且复用次级按钮行（不推高 CTA）', () => {
    const menu = src('src/ui/Menu.ts');
    expect(menu).toContain("dataset.motionBlur = 'toggle'");
    expect(menu).toContain('动态模糊：');
    expect(menu.indexOf('subRow.append(this.blurButton)')).toBeGreaterThan(
      menu.indexOf("subRow.append(this.hdButton)")
    );
  });
});

describe('R47 · 车轮内外侧方向', () => {
  it('外部轮几何绕 Y 刚性旋转 π，与 body.rotation.y=π 对齐', () => {
    const shell = src('src/model/external/ExternalShell.ts');
    expect(shell).toContain('mesh.geometry.rotateY(Math.PI)');
    expect(shell).toContain('r47wheel=off');
  });

  it('车身组确为 rotY(π)（定罪前提，勿被后续重构抹掉）', () => {
    expect(src('src/model/V800Adapter.ts')).toContain('body.rotation.y = Math.PI');
  });
});

describe('R47 · 内外模透视 / cabin 态外模', () => {
  it('handle 暴露 setGlassOpaque，且只改 opacity 不触发 program 重编译', () => {
    const shell = src('src/model/external/ExternalShell.ts');
    expect(shell).toContain('setGlassOpaque(opaque: boolean): void');
    expect(shell).toContain('const next = opaque ? 1 : 0.55');
    expect(shell).toContain('glassMat.opacity = next');
  });

  it('两台适配器 cabin 态不再整壳隐藏，且留 #r47cabin=off 回滚', () => {
    for (const f of ['src/model/V800Adapter.ts', 'src/model/R7Adapter.ts']) {
      const s = src(f);
      expect(s).toContain('r47cabin=off');
      expect(s).toContain('shellHandle.bodyMesh.visible = r47CabinFix || !interior');
      expect(s).toContain('shellHandle.setGlassOpaque(!interior && r47CabinFix)');
    }
  });
});

describe('R47 · 运行时流畅度', () => {
  it('SpeedBlur 两个 shader 都有零成本 early-out（默认态 1 次采样）', () => {
    const postfx = src('src/render/Postfx.ts');
    const hits = postfx.match(/if \(strength <= 0\.0001 && flash <= 0\.0001\)/g) ?? [];
    expect(hits.length).toBe(2);
    expect(postfx).toContain('gl_FragColor = texture2D(tDiffuse, vUv);');
  });
});

describe('R47 · 高精度方向盘接入', () => {
  it('资产就位（两车各 1 份 GLB + 1024² 贴图）', () => {
    for (const car of ['v800', 'r7']) {
      for (const f of ['steering.glb', 'steering_basecolor.webp']) {
        const p = resolve(__dirname, '..', 'src/assets/cars', car, f);
        expect(existsSync(p)).toBe(true);
        expect(statSync(p).size).toBeGreaterThan(50_000);
      }
    }
  });

  it('装配 scale 用 manifest.scale，不是契约 §2.3 的 1（主理人裁决）', () => {
    const m = src('src/model/external/InteriorSteering.ts');
    expect(m).toContain('steering.scale.setScalar(scale)');
    expect(m).toContain('STEERING_PLACEMENT');
    expect(m).toContain("m.name === 'steering'");
    expect(m).toContain("tex.flipY = false");
    expect(m).toContain('metalness: 0.1');
    expect(m).toContain('roughness: 0.65');
  });

  it('两台适配器挂载方向盘且仅 cabin 态可见', () => {
    for (const f of ['src/model/V800Adapter.ts', 'src/model/R7Adapter.ts']) {
      const s = src(f);
      expect(s).toContain("loadInteriorSteering('");
      expect(s).toContain('shell.manifest.scale');
    }
    // V800（本批不动）：仍走 setPaintShadow 内的差量写。
    const v800 = src('src/model/V800Adapter.ts');
    expect(v800).toContain('if (steeringMesh) steeringMesh.visible = interior;');
    expect(v800).toContain('wheel.visible = lastInteriorState;');
    // R7（W1）：方向盘显隐收敛进 applyVisibility 每帧全量覆盖 —— cabin 显高精盘、
    // 近距门控(steerNear)覆盖切程序化盘。语义等价「仅 cabin 态可见」并多一层门控，
    // 故钉新结构（不再是 lastInteriorState 差量）。
    const r7 = src('src/model/R7Adapter.ts');
    expect(r7).toContain('if (steeringMesh) steeringMesh.visible = interior && !steerNear;');
    expect(r7).toContain('for (const m of proceduralSteeringMeshes) m.visible = interior && steerNear;');
  });
});

describe('R47 · 方块内饰外景隐藏 + R7 尾灯台账', () => {
  it('两台适配器都隐藏方块内饰外景透出，R7 收敛进 applyVisibility 的 isBlock/isPoke 合取', () => {
    // V800（本批不动）：独立 Set 差量登记 + 调用顺序在 poke 之后。
    const v800 = src('src/model/V800Adapter.ts');
    expect(v800).toContain('const r47BlockHidden = new Set<THREE.Mesh>()');
    expect(v800).toContain("mesh.name !== 'welcome-carpet'");
    expect(v800.indexOf('setCabinBlocksHidden(!interior && r47CabinFix)')).toBeGreaterThan(
      v800.indexOf('setPokeHidden(!interior)')
    );
    // R7（W1）：删 r47BlockHidden / setCabinBlocksHidden / setPokeHidden 差量账本，改为
    // buildVisibilityTable 打 isBlock / isPoke tag + applyVisibility 每帧合取覆盖。原断言
    // 防的回归（方块内饰外景不透出 + poke 件外景不透顶）在 applyVisibility 里等价钉住：
    //   · isPoke  ⇒ 外景藏车顶穿透件（v = v && interior）
    //   · isBlock ⇒ 外景藏方块内饰（v = v && (interior || !r47CabinFix)），#r47cabin=off 不藏
    //   · welcome-carpet 仍排除在方块之外（迎宾光毯由 exterior 静态 keep 单独管）
    const r7 = src('src/model/R7Adapter.ts');
    expect(r7).toContain('if (e.isPoke) v = v && interior;');
    expect(r7).toContain('if (e.isBlock) v = v && (interior || !r47CabinFix);');
    expect(r7).toContain("if (keepByName && mesh.name !== 'welcome-carpet') isBlock = true;");
    // 旧差量账本 / 函数确已删除（防复活）
    expect(r7).not.toContain('const r47BlockHidden = new Set<THREE.Mesh>()');
    expect(r7).not.toContain('const setCabinBlocksHidden =');
    expect(r7).not.toContain('const setPokeHidden =');
  });

  it('R7 尾灯语义件已从车牌板重产为横贯灯带（tri 1,136 → 14,333）', () => {
    const m = JSON.parse(src('src/assets/cars/r7/manifest.json')) as {
      semantic: { lamp_rear: { tri: number } };
    };
    expect(m.semantic.lamp_rear.tri).toBe(14_333);
  });
});
