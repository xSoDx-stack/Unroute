// Source-render geometry checks only; startup JS is deliberately disabled.
// Behavior is covered separately by multiproxy-ui-dom and installed-build smoke.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const executablePath = process.env.CHROME_BIN || process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const output = path.resolve('artifacts/proxy-settings-layout');
mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--allow-file-access-from-files', '--no-sandbox'] });
let checks = 0;
try {
  for (const locale of ['ru', 'en']) for (const theme of ['light', 'dark']) for (const width of [360, 640, 900, 1280]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 1000 });
    await page.setJavaScriptEnabled(false);
    await page.goto(pathToFileURL(path.resolve('src/common/pages/options/index.html')).href);
    await page.setJavaScriptEnabled(true);
    const catalog = JSON.parse(readFileSync(path.resolve(`src/common/_locales/${locale}/messages.json`), 'utf8'));
    await page.evaluate(({ theme, locale, catalog }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.lang = locale;
      for (const node of document.querySelectorAll('[data-i18n]')) {
        const entry = catalog[node.dataset.i18n];
        if (entry) node.textContent = entry.message;
      }
      for (const node of document.querySelectorAll('.tab-content')) node.classList.toggle('active', node.id === 'tab-proxies');
      for (const node of document.querySelectorAll('.nav-tab-btn')) node.classList.toggle('active', node.dataset.tab === 'proxies');
      document.querySelector('#defaultProxySelect').add(new Option('Work', 'fixture'));
      document.querySelector('#proxyFailoverSelect').add(new Option(catalog.proxyFailoverBlock.message, 'block'));
      document.querySelector('#proxyName').value = 'Work';
      document.querySelector('#proxyHost').value = 'proxy.example.test';
      document.querySelector('#proxyPort').value = '8080';
      document.querySelector('#proxyAuthCheck').checked = true;
      document.querySelector('#proxyAuthFields').style.display = 'grid';
    }, { theme, locale, catalog });
    const geometry = await page.evaluate(() => {
      const box = id => {
        const node = document.getElementById(id), r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, labelled: Boolean(node.labels?.length) };
      };
      const ids = ['defaultProxySelect', 'proxyFailoverSelect', 'proxyName', 'proxyProtocol', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyPass'];
      const fields = Object.fromEntries(ids.map(id => [id, box(id)]));
      const hint = document.getElementById('proxyFailoverHint');
      return { fields, hint: { height: hint.getBoundingClientRect().height, font: parseFloat(getComputedStyle(hint).lineHeight) }, overflow: document.documentElement.scrollWidth > innerWidth, card: document.querySelector('#tab-proxies .card').getBoundingClientRect().toJSON() };
    });
    const label = `${locale}/${theme}/${width}`;
    const { defaultProxySelect: first, proxyFailoverSelect: second } = geometry.fields;
    if (width > 640) {
      assert.ok(Math.abs(first.y - second.y) < 1, `${label}: policy selectors share one baseline`);
      assert.ok(Math.abs(first.w - second.w) < 1, `${label}: equal policy column widths`);
      assert.ok(second.x >= first.right + 7, `${label}: policy fields do not overlap`);
    } else {
      assert.ok(Math.abs(first.x - second.x) < 1 && Math.abs(first.w - second.w) < 1, `${label}: stacked full-width fields align`);
      assert.ok(second.y > first.bottom, `${label}: readable stacked labels`);
    }
    for (const [id, field] of Object.entries(geometry.fields)) {
      assert.ok(Math.abs(field.h - 36) < 1, `${label}/${id}: consistent 36px control height (actual ${field.h})`);
      assert.ok(field.labelled, `${label}/${id}: associated label`);
      assert.ok(field.w > 40 && field.x >= geometry.card.x - 1 && field.right <= geometry.card.right + 1, `${label}/${id}: field fits card`);
    }
    assert.equal(geometry.overflow, false, `${label}: no horizontal overflow`);
    if (width >= 900) assert.ok(geometry.hint.height <= geometry.hint.font + 1, `${label}: concise one-line explanation`);
    if (locale === 'ru' && [360, 1280].includes(width)) {
      await (await page.$('#tab-proxies')).screenshot({ path: path.join(output, `${theme}-${width}.png`) });
    }
    await page.close();
    checks++;
  }
  console.log(`PASS proxy settings geometry: ${checks} ru/en light/dark viewports, aligned policy columns, 36px controls, labels, concise hint, no overflow. Screenshots: ${output}`);
} finally { await browser.close(); }
