import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Runs inside the installed build with its real storage, controller and RPC.
// The separate golden-DOM tests compare reference geometry on identical text.
export async function verifyBuiltUILayout(page) {
  const output = path.resolve('artifacts/ui-fidelity/live');
  fs.mkdirSync(output, { recursive: true });
  const tabs = ['pac', 'exceptions', 'proxies', 'mods', 'logs', 'history', 'tools', 'notifications', 'appearance'];
  const polling = { polling: 50, timeout: 15000 };
  await page.bringToFront();
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
  await page.$eval('[data-tab="appearance"]', button => button.click());
  await page.waitForSelector('#appearanceTheme');
  const originalTheme = await page.$eval('#appearanceTheme', select => select.value);
  const results = [];
  try {
    for (const theme of ['light', 'dark']) {
      await page.select('#appearanceTheme', theme);
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, polling, theme);
      for (const tab of tabs) {
        await page.$eval(`[data-tab="${tab}"]`, button => button.click());
        await page.waitForFunction(value => document.querySelector(`#tab-${value}.active`), polling, tab);
        const metrics = await page.evaluate(() => {
          const pane = document.querySelector('.tab-content.active');
          const heading = pane.querySelector('.card-title, h1, .appearance-title');
          return { width: document.body.getBoundingClientRect().width,
            header: document.querySelector('.app-header').getBoundingClientRect().height,
            sidebar: document.querySelector('.nav-tabs').getBoundingClientRect().width,
            panePadding: getComputedStyle(pane).padding,
            titleSize: heading && getComputedStyle(heading).fontSize,
            overflow: document.documentElement.scrollWidth > innerWidth,
            brand: document.querySelector('.brand-logo').getAttribute('src'),
            current: document.querySelector('.nav-tab-btn.active').getAttribute('aria-current'),
            currentCount: document.querySelectorAll('.nav-tabs [aria-current="page"]').length };
        });
        assert.equal(metrics.width, 900, `${theme}/${tab} workspace`);
        assert.equal(metrics.header, 54, `${theme}/${tab} header`);
        assert.equal(metrics.sidebar, 164, `${theme}/${tab} sidebar`);
        assert.equal(metrics.panePadding, '24px 28px', `${theme}/${tab} pane`);
        assert.equal(metrics.titleSize, '20px', `${theme}/${tab} heading`);
        assert.equal(metrics.overflow, false, `${theme}/${tab} horizontal overflow`);
        assert.equal(metrics.brand, '../../icons/default-128.png');
        assert.equal(metrics.current, 'page', `${theme}/${tab} accessible current section`);
        assert.equal(metrics.currentCount, 1, `${theme}/${tab} unique current section`);
        await page.screenshot({ path: path.join(output, `${tab}-${theme}.png`), fullPage: true });
        results.push({ theme, tab, ...metrics });
      }
    }
    fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2));
    console.log('Installed build UI: all 9 settings panels × 2 themes match 01 shell geometry; 18 real-extension screenshots.');
  } finally {
    await page.$eval('[data-tab="appearance"]', button => button.click());
    await page.select('#appearanceTheme', originalTheme);
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  }
}
