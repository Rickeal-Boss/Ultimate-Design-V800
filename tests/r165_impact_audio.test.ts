/**
 * R165 · 撞击音频低频增强护栏（源码契约风格同 r162_impact_glare.test.ts）：
 *  ① 新增低频「body」噪声分量（低通 150→350Hz 随强度）；
 *  ② 车身共振闷响 70→60Hz（更贴车身面板共振），增益/时长随强度标定；
 *  ③ 高频 crunch 保留但增益微降（0.3+0.4s → 0.2+0.25s）给低频让位；
 *  ④ 红线：其他 SFX 方法 / master 0.6 / noiseBurst 签名零改；
 *  ⑤ 数学烟雾：三路峰值和 × master 0.6 < 1.0（无 clip），且 strength=1 > strength=0（标定生效）。
 *
 * Sfx 依赖 WebAudio ctx（node 不可实例化），故钉源码结构 + 对增益表达式做数值烟雾。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (p: string): string =>
  readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sfx = src('src/audio/Sfx.ts');

/** 仅取 impact 方法体（到下一个 public 方法 success 为止） */
const impactSrc = sfx.slice(
  sfx.indexOf('impact(strength: number): void'),
  sfx.indexOf('success(): void')
);

/** 解析形如 `A + strength * B` 的线性增益表达式 */
function parseLin(expr: string): [number, number] {
  const m = expr.match(/^\s*([\d.]+)\s*\+\s*strength\s*\*\s*([\d.]+)\s*$/);
  if (!m) throw new Error('bad linear expr: ' + expr);
  return [parseFloat(m[1]), parseFloat(m[2])];
}
const evalLin = (expr: string, s: number): number => {
  const [a, b] = parseLin(expr);
  return a + b * s;
};

describe('R165 ① · 低频 body 分量存在', () => {
  it('含 R165 注释 + 第二个 noiseBurst（低通 150→350Hz 随强度）', () => {
    expect(impactSrc).toContain('R165 · 低频「body」');
    expect(impactSrc).toContain('this.noiseBurst(0.35 + strength * 0.35, 0.2 + strength * 0.3, 150 + strength * 200);');
  });
});

describe('R165 ② · 共振降频（70→60Hz）', () => {
  it('含 beep(60, 0.35+0.15s, sine, 0.2+0.2s)，不再有固定 beep(70, 0.4, sine, 0.35)', () => {
    expect(impactSrc).toContain(
      "this.beep(60, 0.35 + strength * 0.15, 'sine', 0.2 + strength * 0.2);"
    );
    expect(impactSrc).not.toContain("this.beep(70, 0.4, 'sine', 0.35);");
  });
});

describe('R165 ③ · 强度标定', () => {
  it('beep 增益随 strength 变化（0.2+0.2s），crunch 低通保留 500+1500s', () => {
    expect(impactSrc).toContain("this.beep(60, 0.35 + strength * 0.15, 'sine', 0.2 + strength * 0.2);");
    expect(impactSrc).toContain('this.noiseBurst(0.3 + strength * 0.3, 0.2 + strength * 0.25, 500 + strength * 1500);');
  });
});

describe('R165 ④ · 红线：其他 SFX / master / noiseBurst 签名零改', () => {
  it('其他 SFX 方法保留', () => {
    for (const m of ['countdownBeep', 'brakeClick', 'snap', 'success', 'fail']) {
      expect(sfx).toContain(m);
    }
  });
  it('master 增益 0.6 不变（unlock / setMuted 两处）', () => {
    const occurrences = sfx.match(/0\.6/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    expect(sfx).toContain('this.master.gain.value = this.muted ? 0 : 0.6;');
    expect(sfx).toContain('this.master.gain.value = muted ? 0 : 0.6;');
  });
  it('noiseBurst 签名不变', () => {
    expect(sfx).toContain(
      'private noiseBurst(duration: number, gain: number, filterHz: number): void'
    );
  });
});

describe('R165 ⑤ · 数学烟雾（无 clip + 标定生效）', () => {
  it('strength=0 / strength=1 三路峰值和 × master 0.6 均 < 1.0', () => {
    const gains = [
      '0.2 + strength * 0.25', // crunch
      '0.2 + strength * 0.3', // body
      '0.2 + strength * 0.2' // 共振
    ];
    for (const s of [0, 1]) {
      const peak = gains.reduce((acc, g) => acc + evalLin(g, s), 0);
      expect(peak * 0.6).toBeLessThan(1.0);
    }
  });
  it('strength=1 峰值 > strength=0 峰值（强度标定生效）', () => {
    const gains = [
      '0.2 + strength * 0.25',
      '0.2 + strength * 0.3',
      '0.2 + strength * 0.2'
    ];
    const peak0 = gains.reduce((a, g) => a + evalLin(g, 0), 0);
    const peak1 = gains.reduce((a, g) => a + evalLin(g, 1), 0);
    expect(peak1).toBeGreaterThan(peak0);
  });
  it('source 中的实际增益表达式与烟雾一致（防漂移）', () => {
    expect(impactSrc).toContain('this.noiseBurst(0.3 + strength * 0.3, 0.2 + strength * 0.25, 500 + strength * 1500);');
    expect(impactSrc).toContain('this.noiseBurst(0.35 + strength * 0.35, 0.2 + strength * 0.3, 150 + strength * 200);');
    expect(impactSrc).toContain("this.beep(60, 0.35 + strength * 0.15, 'sine', 0.2 + strength * 0.2);");
  });
});
