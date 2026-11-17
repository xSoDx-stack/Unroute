import { expect } from 'chai';
import fs from 'node:fs';

describe('Brand assets and readable theme colors', () => {
  it('ships correctly sized transparent PNGs for toolbar, disabled, and notification states', () => {
    const icons = [];
    for (const size of [16, 32, 48, 128]) {
      icons.push([`default-${size}.png`, size], [`default-grayscale-${size}.png`, size]);
    }
    for (const state of ['pac-error', 'ext-error', 'no-control']) icons.push([`${state}-128.png`, 128]);
    for (const [file, size] of icons) {
      const png = fs.readFileSync(new URL(`../src/common/icons/${file}`, import.meta.url));
      expect(png.subarray(0, 8).toString('hex'), file).to.equal('89504e470d0a1a0a');
      expect(png.readUInt32BE(16), file).to.equal(size);
      expect(png.readUInt32BE(20), file).to.equal(size);
      expect(png[25], file).to.equal(6); // RGBA, including transparent tile corners.
    }
  });

  it('keeps text contrast at least 4.5:1 in both themes', () => {
    const source = fs.readFileSync(new URL('../src/common/pages/shared/theme.css', import.meta.url), 'utf8');
    const [dark, light] = source.split('@media (prefers-color-scheme: light)');
    const values = text => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[a-f0-9]{3}(?:[a-f0-9]{3})?);/gi)]
      .map(match => [match[1], match[2].length === 4 ? '#' + [...match[2].slice(1)].map(value => value + value).join('') : match[2]]));
    const darkColors = values(dark);
    function luminance(hex) {
      return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    }
    for (const colors of [darkColors, { ...darkColors, ...values(light) }]) {
      for (const [foreground, background] of [
        ['text-primary', 'bg-primary'], ['text-secondary', 'bg-surface'], ['text-muted', 'bg-surface-hover'],
        ['on-accent', 'accent-primary'], ['on-accent', 'accent-hover'], ['accent-text', 'accent-soft'],
        ['success', 'success-bg'], ['warning', 'warning-bg'], ['danger', 'danger-bg'], ['on-danger', 'danger'],
      ]) {
        const a = luminance(colors[foreground]), b = luminance(colors[background]);
        const contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        expect(contrast, `${foreground} on ${background}`).to.be.at.least(4.5);
      }
    }
  });
});
