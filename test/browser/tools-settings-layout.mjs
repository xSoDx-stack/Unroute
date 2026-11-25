// Source-render geometry/typography only; actual RPC/file flows are tested separately.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const output = path.resolve('artifacts/tools-settings-layout');
mkdirSync(output, { recursive: true });
const executablePath = process.env.CHROME_BIN || process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });
let checked = 0;
try {
  for (const locale of ['ru', 'en']) for (const theme of ['light', 'dark']) for (const width of [360, 640, 900, 1280]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 1000 });
    await page.setJavaScriptEnabled(false);
    await page.goto(pathToFileURL(path.resolve('src/common/pages/options/index.html')).href);
    await page.setJavaScriptEnabled(true);
    const catalog = JSON.parse(readFileSync(path.resolve(`src/common/_locales/${locale}/messages.json`), 'utf8'));
    await page.evaluate(({ locale, theme, catalog }) => {
      document.documentElement.lang = locale;
      document.documentElement.dataset.theme = theme;
      for (const node of document.querySelectorAll('[data-i18n]')) if (catalog[node.dataset.i18n]) node.textContent = catalog[node.dataset.i18n].message;
      for (const node of document.querySelectorAll('.tab-content')) node.classList.toggle('active', node.id === 'tab-tools');
      for (const node of document.querySelectorAll('.nav-tab-btn')) node.classList.toggle('active', node.dataset.tab === 'tools');
    }, { locale, theme, catalog });
    const state = await page.evaluate(() => {
      const tab = document.getElementById('tab-tools');
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const typography = node => { const s = getComputedStyle(node); return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight]; };
      const nav = document.querySelector('body > .nav-tabs');
      const information = nav.querySelector('[data-tab=notifications]');
      return {
        heading: tab.querySelector('.card-title').textContent.trim(), headings: tab.querySelectorAll('.card-title').length,
        nav: nav.querySelector('[data-tab=tools]').textContent.trim(), lastTab: [...nav.querySelectorAll('[data-tab]')].at(-1).dataset.tab,
        infoBox: rect(information), navBox: rect(nav), navPadding: parseFloat(getComputedStyle(nav).paddingBottom),
        titles: [...tab.querySelectorAll('.switch-title')].map(typography), descriptions: [...tab.querySelectorAll('.switch-desc')].map(typography),
        buttons: [...tab.querySelectorAll('button')].map(node => ({ id: node.id, ...rect(node), typography: typography(node), fits: node.scrollWidth <= node.clientWidth + 1 })),
        warning: { visible: Boolean(document.getElementById('portable-warning').getClientRects().length), text: document.getElementById('portable-warning').textContent.trim() },
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    const label = `${locale}/${theme}/${width}`;
    assert.equal(state.lastTab, 'notifications', `${label}: Information is the last navigation item`);
    assert.equal(state.heading, locale === 'ru' ? 'Инструменты' : 'Tools', `${label}: useful section name`);
    assert.equal(state.nav, state.heading, `${label}: navigation matches heading`);
    assert.equal(state.headings, 1, `${label}: no competing section headings`);
    assert.equal(state.titles.length, 4, `${label}: four peer tool rows`);
    assert.ok(state.titles.every(style => JSON.stringify(style) === JSON.stringify(state.titles[0])), `${label}: uniform row-title typography`);
    assert.ok(state.descriptions.every(style => JSON.stringify(style) === JSON.stringify(state.descriptions[0])), `${label}: uniform descriptions`);
    assert.deepEqual(state.buttons.map(button => button.id), ['portable-export', 'portable-import', 'testConnBtn', 'viewPacScriptBtn', 'resetSettingsBtn']);
    for (const button of state.buttons) {
      assert.ok(Math.abs(button.width - state.buttons[0].width) < 1 && Math.abs(button.right - state.buttons[0].right) < 1, `${label}/${button.id}: aligned equal-width actions`);
      assert.equal(button.typography[1], '12px', `${label}/${button.id}: uniform action text`);
      assert.ok(button.height >= 32 && button.fits && button.x >= 0 && button.right <= width, `${label}/${button.id}: usable unclipped action`);
    }
    assert.equal(state.warning.visible, true, `${label}: plaintext password warning stays visible`);
    assert.match(state.warning.text, locale === 'ru' ? /логины и пароли/ : /usernames and passwords/);
    assert.equal(state.overflow, false, `${label}: no horizontal overflow`);
    if (width > 640) assert.ok(Math.abs(state.infoBox.bottom - (state.navBox.bottom - state.navPadding)) < 2, `${label}: Information sits at the bottom of the sidebar`);
    if (locale === 'ru' && [360, 1280].includes(width)) await (await page.$('body')).screenshot({ path: path.join(output, `${theme}-${width}.png`) });
    await page.close();
    checked++;
  }
  console.log(`PASS tools settings: ${checked} ru/en light/dark viewports, navigation order, one heading, uniform rows/actions, visible warning and no overflow. Screenshots: ${output}`);
} finally { await browser.close(); }
