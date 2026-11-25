import { expect } from 'chai';
import fs from 'node:fs';

describe('Appearance CSS fallback', () => {
  it('ships graphite/mint defaults and explicit theme overrides without losing existing tokens', () => {
    const css = fs.readFileSync(new URL('../src/common/pages/shared/theme.css', import.meta.url), 'utf8');
    expect(css).include('--bg-primary: #111415;');
    expect(css).include('--brand-mint: #78c6b0;');
    expect(css).include(':root[data-theme="light"]');
    expect(css).include(':root[data-theme="dark"]');
    for (const key of ['brand-cyan', 'brand-violet', 'brand-gradient', 'accent-gradient', 'focus-ring', 'radius-full', 'shadow-sm', 'transition', 'status-on', 'status-off', 'status-warn', 'status-err']) {
      expect(css).include(`--${key}:`);
    }
  });
  it('keeps static CSS fallback tokens identical to getPalette defaults for dark and light themes', async () => {
    const css = fs.readFileSync(new URL('../src/common/pages/shared/theme.css', import.meta.url), 'utf8');
    const { getPalette } = await import('../src/common/pages/shared/appearance.js');
    const parseVars = block => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
    const darkBlock = parseVars(css.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);
    const mediaLightBlock = parseVars(css.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{([\s\S]*?)\n\}/)[1]);
    const explicitLightBlock = parseVars(css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)[1]);
    expect(mediaLightBlock).to.deep.equal(explicitLightBlock);
    for (const [key, value] of Object.entries(getPalette({ theme: 'dark' }))) expect(darkBlock[key], `dark --${key}`).to.equal(value);
    for (const [key, value] of Object.entries(getPalette({ theme: 'light' }))) expect(explicitLightBlock[key], `light --${key}`).to.equal(value);
  });
});

const moduleUrl = '../src/common/pages/shared/appearance.js';
function contrast(a, b) {
  const luminance = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
describe('Accessible appearance palettes', () => {
  it('corrects arbitrary accents while leaving brand mint and semantics fixed', async () => {
    const { getPalette } = await import(moduleUrl);
    const colors = ['#000000', '#ffffff', '#777777', '#ff0000', '#00ff00', '#0000ff', '#78c6b0', '#82b3dd', '#a3bc9e'];
    for (let i = 0; i < 128; i++) colors.push('#' + ((i * 123457) % 0xffffff).toString(16).padStart(6, '0'));
    for (const theme of ['dark', 'light']) {
      const baseline = getPalette({ theme });
      for (const custom of colors) {
        const p = getPalette({ theme, accent: 'custom', customColor: custom });
        for (const bg of ['accent-primary', 'accent-hover']) expect(contrast(p['on-accent'], p[bg]), `${custom} button ${theme}`).at.least(4.5);
        for (const bg of ['bg-primary', 'bg-surface', 'bg-inset', 'bg-surface-hover', 'bg-surface-active', 'accent-soft']) {
          expect(contrast(p['accent-text'], p[bg]), `${custom} text ${theme} ${bg}`).at.least(4.5);
          expect(contrast(p['focus-ring'], p[bg]), `${custom} focus ${theme} ${bg}`).at.least(3);
        }
        expect(p['brand-mint']).equal('#78c6b0');
        for (const key of ['danger', 'success', 'warning', 'danger-bg', 'success-bg']) expect(p[key]).equal(baseline[key]);
      }
    }
    expect(getPalette({ theme: 'dark' })['bg-primary']).equal('#111415');
    expect(getPalette({ theme: 'dark' })['bg-surface']).equal('#171a1c');
    expect(getPalette({ theme: 'light' })['bg-primary']).equal('#fafbfd');
    expect(getPalette({ theme: 'system' }, true)).deep.equal(getPalette({ theme: 'dark' }));
  });
});
describe('Appearance normalization', () => {
  it('defaults safely and preserves a valid custom color independently of theme/preset', async () => {
    const { normalizeAppearance } = await import(moduleUrl);
    const defaults = { theme: 'system', accent: 'mint', customColor: '#78c6b0' };
    for (const value of [undefined, null, [], 'dark', 12, { theme: {}, accent: '__proto__', customColor: '#fff000;' }]) {
      expect(normalizeAppearance(value)).to.deep.equal(defaults);
    }
    expect(normalizeAppearance({ theme: 'light', accent: 'blue', customColor: '#AbC' }))
      .to.deep.equal({ theme: 'light', accent: 'blue', customColor: '#aabbcc' });
    expect(normalizeAppearance({ theme: 'dark', accent: 'custom', customColor: '#123456' }))
      .to.deep.equal({ theme: 'dark', accent: 'custom', customColor: '#123456' });
  });
});
