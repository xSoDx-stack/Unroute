import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
const out = process.env.FIDELITY_OUT || path.resolve('artifacts/ui-fidelity/reference-options');
const actualRoot = path.resolve(process.argv.includes('--source') ? 'src/common' : 'dist/chromium');
await fs.mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--allow-file-access-from-files'] });
try {
 const page = await browser.newPage();
 await page.setViewport({ width: 1200, height: 900 });
 await page.goto(pathToFileURL(path.resolve('test/fixtures/design-01.html')).href);
 await page.click('[data-view="settings"]');
 const measure = async (selectors) => page.evaluate((sels) => Object.fromEntries(Object.entries(sels).map(([key, sel]) => {
  const e = document.querySelector(sel); if (!e) return [key, null]; const s = getComputedStyle(e), r = e.getBoundingClientRect();
  return [key, { width: r.width, height: r.height, padding: s.padding, fontSize: s.fontSize, lineHeight: s.lineHeight, borderRadius: s.borderRadius, gap: s.gap }];
 })), selectors);
 const reference = await measure({ workspace: '.workspace', header: '.workspace .app-head', sidebar: '.sidebar', nav: '.sidebar button', pane: '.pane', title: '.pane h2', provider: '.provider', footer: '.statusbar' });
 await page.screenshot({ path: `${out}/reference-pac.png`, fullPage: true });
 for (const tab of ['sites','proxies','options','logs','history','test','info']) {
  await page.click(`.sidebar [data-tab="${tab}"]`);
  await page.screenshot({ path: `${out}/reference-${tab}.png`, fullPage: true });
 }
 // Packaged DOM rendering only: extension startup is disabled, not mocked.
 await page.setJavaScriptEnabled(false);
 await page.goto(pathToFileURL(path.join(actualRoot, 'pages/options/index.html')).href);
 await page.setJavaScriptEnabled(true);
 await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.querySelectorAll('.nav-tab-btn').forEach(e => e.classList.toggle('active', e.dataset.tab === 'pac')); document.querySelectorAll('.tab-content').forEach(e => e.classList.toggle('active', e.id === 'tab-pac')); });
 const { version } = JSON.parse(await fs.readFile(path.join(actualRoot, 'manifest.json'), 'utf8'));
 const catalogs = Object.fromEntries(await Promise.all(['ru','en'].map(async locale => [locale,
  JSON.parse(await fs.readFile(path.join(actualRoot, '_locales', locale, 'messages.json'), 'utf8'))])));
 const localize = async locale => page.evaluate(async ({ messages, version }) => {
  // Source/packaged DOM copy check only, not native extension startup.
  window.chrome = { i18n: { getMessage: key => messages[key]?.message || '' } };
  const { localizeDocument } = await import('../../core/i18n.js'); localizeDocument(document);
  document.querySelector('#extVersion').textContent = `v${version}`;
 }, { messages: catalogs[locale], version });
 for (const locale of ['ru','en']) {
  await localize(locale);
  for (const theme of ['light','dark']) for (const width of [360,640,900,1200]) {
   await page.setViewport({ width, height: 900 });
   const copy = await page.evaluate(theme => {
    document.documentElement.dataset.theme = theme;
    const header = document.querySelector('.app-header'), version = document.querySelector('#extVersion'),
     footer = document.querySelector('.statusbar'), hint = footer.querySelector('[data-i18n="fidelity_footer_hint"]');
    const box = hint.getBoundingClientRect(), foot = footer.getBoundingClientRect(), v = version.getBoundingClientRect(),
     style = getComputedStyle(footer);
    return { branding: [header,document.querySelector('.nav-tabs'),footer].map(e=>e.textContent).join(' ').match(/Unroute/g)?.length || 0,
     caption: header.querySelector('.header-caption') !== null, version: version.textContent.trim(),
     inFooter: version.parentElement === footer && !document.querySelector('.nav-tabs #extVersion') && document.querySelectorAll('#extVersion').length === 1,
     aligned: Math.abs(v.left-foot.left-parseFloat(style.paddingLeft))<1 && Math.abs(box.right-foot.right+parseFloat(style.paddingRight))<1 &&
      Math.abs(v.top+v.height/2-box.top-box.height/2)<1 && v.right<box.left,
     visible: v.width > 0 && v.height > 0 && box.width > 0 && box.height > 0,
     fits: box.left >= foot.left && box.right <= foot.right, overflow: document.documentElement.scrollWidth > innerWidth };
   }, theme);
   assert.equal(copy.branding, 1, `${locale}/${theme}/${width}: one brand in settings chrome`);
   assert.equal(copy.caption, false, 'settings context does not need a second header label');
   assert.equal(copy.version, `v${version}`, 'runtime version is retained');
   assert.ok(copy.inFooter, 'version appears once, in the statusbar instead of the sidebar');
   assert.ok(copy.aligned, `${locale}/${theme}/${width}: version left, autosave right on the same line`);
   assert.ok(copy.visible && copy.fits && !copy.overflow, `${locale}/${theme}/${width}: readable footer without overflow`);
   if (width === 360 || width === 1200) await page.screenshot({ path: `${out}/brand-${locale}-${theme}-${width}.png`, fullPage: true });
  }
 }
 await localize('ru'); await page.setViewport({ width:1200, height:900 });
 await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
 const production = await measure({ workspace: 'body', header: '.app-header', sidebar: '.nav-tabs', nav: '.nav-tab-btn', pane: '#tab-pac', title: '#tab-pac .card-title', provider: '.provider-card', footer: '.statusbar' });
 await fs.writeFile(`${out}/metrics.json`, JSON.stringify({ reference, production }, null, 2));
 await page.screenshot({ path: `${out}/production-pac.png`, fullPage: true });
 for (const key of ['header', 'nav', 'pane', 'title', 'provider', 'footer']) {
  for (const prop of ['padding', 'fontSize', 'lineHeight']) assert.equal(production[key][prop], reference[key][prop], `${key}.${prop}`);
 }
 assert.ok(await page.evaluate(() => document.querySelector('.statusbar').getBoundingClientRect().top >= document.querySelector('#tab-pac').getBoundingClientRect().bottom), 'statusbar must be below the pane, not in the pending-banner row');
 assert.equal(production.workspace.width, 900);
 assert.equal(production.workspace.borderRadius, '9px');
 assert.equal(production.sidebar.width, 164);
 assert.equal(production.nav.gap, '9px');
 await page.evaluate(async () => {
  const { initAppearanceControls } = await import('../shared/appearance-controls.js');
  const { createAppearanceController } = await import('../shared/appearance.js');
  // Real component + controller; unavailable extension storage is shown as an error, not faked.
  initAppearanceControls(document.querySelector('#appearanceSettings'), createAppearanceController({ chrome: null }));
 });
 for (const tab of ['exceptions','proxies','mods','logs','history','tools','notifications','appearance']) {
  await page.evaluate((name) => document.querySelectorAll('.tab-content').forEach(e => e.classList.toggle('active', e.id === `tab-${name}`)), tab);
  await page.evaluate((name) => document.querySelectorAll('.nav-tab-btn').forEach(e => e.classList.toggle('active', e.dataset.tab === name)), tab);
  await page.screenshot({ path: `${out}/production-${tab}.png`, fullPage: true });
 }
 for (const width of [360, 640, 900, 1200]) {
  await page.setViewport({ width, height: 900 });
  for (const tab of ['pac','exceptions','proxies','mods','logs','history','tools','notifications','appearance']) {
   await page.evaluate((name) => document.querySelectorAll('.tab-content').forEach(e => e.classList.toggle('active', e.id === `tab-${name}`)), tab);
  await page.evaluate((name) => document.querySelectorAll('.nav-tab-btn').forEach(e => e.classList.toggle('active', e.dataset.tab === name)), tab);
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tab} overflows at ${width}`);
  }
 }
 console.log('PASS: 01 layout metrics; 9 packaged DOM-panel screenshots; responsive overflow 360/640/900/1200. Extension startup JS not exercised.');
} finally { await browser.close(); }
