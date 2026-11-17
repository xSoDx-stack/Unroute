import { expect } from 'chai';
import fs from 'node:fs';
const source = path => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

describe('Selected design integration', () => {
  it('offers appearance settings without replacing existing functional sections', () => {
    const html = source('common/pages/options/index.html');
    for (const tab of ['pac', 'exceptions', 'proxies', 'mods', 'logs', 'notifications', 'tools', 'history', 'appearance']) {
      expect(html).to.include(`data-tab="${tab}"`);
      expect(html).to.include(`id="tab-${tab}"`);
    }
    expect(html).to.include('id="appearanceSettings"');
    expect(source('common/pages/options/app.js')).to.include('initAppearanceControls(');
  });

  it('initializes shared appearance in every browser-facing page', () => {
    for (const path of ['common/pages/popup/app.js', 'common/pages/options/app.js', 'firefox/pages/firefox-private-browsing/app.js']) {
      expect(source(path), path).to.include('initAppearance(');
    }
  });

  it('keeps the fixed icon as an image and history out of the popup', () => {
    const popup = source('common/pages/popup/index.html');
    expect(popup).to.include('icons/default-128.png');
    expect(popup).to.not.include('id="lastChange"');
    expect(popup).to.include('class="site-heading"');
    expect(popup).to.include('aria-describedby="actionScope"');
  });
});
