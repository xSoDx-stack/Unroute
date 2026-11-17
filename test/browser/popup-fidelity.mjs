import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const referencePath = path.join(root, 'test/fixtures/design-01.html');
const actualPath = path.join(root, process.argv.includes('--source') ? 'src/common/pages/popup/index.html' : 'dist/chromium/pages/popup/index.html');
assert.ok(fs.existsSync(actualPath), 'Build the extension before checking the packaged UI');
// Approved text-only preset descriptions; reference geometry/CSS is unchanged.
assert.equal(createHash('sha256').update(fs.readFileSync(referencePath)).digest('hex'),
  '9320ff9fe1f1e83127092613bd625aa60555bd2907e0e3cd49c0ca1350c289db', 'The approved reference must not drift with production CSS');
const output = path.join(root, 'artifacts/ui-fidelity');
fs.mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({ headless: true,
  executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const mapping = [
  ['header', '.app-head', 'header'], ['brand', '.brand', '.brand'],
  ['content', '.popup-content', 'main'], ['eyebrow', '.overline', '.eyebrow'],
  ['site', '.site-title', '.site-heading'], ['symbol', '.site-icon', '.site-symbol'],
  ['domain', '.site-title h1', '#domain'],
  ['site connection', '.site-connection-reference', '#modeSwitch'],
  ['site label', '.site-connection-reference > label', '#modeSwitch > label'],
  ['site control', '#referenceSiteRoute', '#siteRoute'],
  ['automatic resources', '.resource-inheritance', '#resourceMode'],
  ['policy heading', '.policy-label-reference', '#inheritResourcesLabel'],
  ['policy control', '.policy-control-reference', '.resource-mode-switch'],
  ['policy help', '.policy-help-reference', '#resourcePolicyHint'],
  ['resources', 'details', '#resourceDetails'], ['summary', 'summary', 'summary'],
  ['footer', '.popup-foot', 'footer'],
  ['connection shortcut', '[data-open=pac]', 'footer [data-section=pac]'],
  ['settings shortcut', '.settings-link', '.settings'],
];
const metrics = (page, isReference) => page.evaluate(({ mapping, isReference }) => {
  const container = isReference ? document.getElementById('popupView') : document.body;
  const bounds = container.getBoundingClientRect();
  return Object.fromEntries(mapping.map(([name, ref, actual]) => {
    const el = container.querySelector(isReference ? ref : actual);
    if (!el) return [name, null];
    const b = el.getBoundingClientRect(), s = getComputedStyle(el);
    // A display:none node has no container-relative geometry; normalize its
    // empty rect rather than subtracting the reference shell's page offset.
    const hidden = s.display === 'none';
    return [name, { x: hidden ? 0 : b.x - bounds.x, y: hidden ? 0 : b.y - bounds.y, width: b.width, height: b.height,
      fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight,
      borderRadius: s.borderRadius, padding: s.padding }];
  }));
}, { mapping, isReference });
try {
  const ref = await browser.newPage(), actual = await browser.newPage();
  for (const page of [ref, actual]) {
    await page.setJavaScriptEnabled(false);
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
  }
  await ref.goto('file:///' + referencePath.replaceAll('\\', '/'));
  await actual.goto('file:///' + actualPath.replaceAll('\\', '/'));
  // Approved extension to the immutable pre-feature design-01 reference:
  // replace three mode buttons + duplicate route/scope with a vertical site
  // label/native select and vertical automatic-resource radio/help block.
  // These fixed reference dimensions are independent of production styles.
  // The header/footer/type mapping and 0.6px rectangle tolerance stay intact.
  await ref.evaluate(() => {
    document.getElementById('scopeText').hidden = true;
    document.querySelector('#popupView .mode-control').remove();
    document.querySelector('#popupView .route-note').remove();
    const site = document.createElement('div');
    site.className = 'site-connection-reference';
    site.style.cssText = 'display:grid;gap:6px;margin:0 0 16px';
    const siteLabel = document.createElement('label');
    siteLabel.textContent = 'Подключение сайта';
    siteLabel.htmlFor = 'referenceSiteRoute';
    siteLabel.style.cssText = 'font-size:12px;font-weight:600';
    const select = document.createElement('select');
    select.id = 'referenceSiteRoute';
    select.style.cssText = 'box-sizing:border-box;width:100%;min-width:0;height:34px;padding:6px 10px;border:1px solid currentColor;border-radius:6px;font:12px "Segoe UI",system-ui,sans-serif';
    select.add(new Option('Автоматически — по PAC', '@pac'));
    site.append(siteLabel, select);
    const policy = document.createElement('div');
    policy.className = 'resource-inheritance';
    policy.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:6px;font-size:12px;line-height:18px';
    const text = document.createElement('span');
    text.className = 'policy-label-reference';
    text.textContent = 'Автоматические ресурсы';
    text.style.fontWeight = '600';
    const control = document.createElement('div');
    control.className = 'policy-control-reference';
    control.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;width:100%;gap:2px;padding:2px;border:1px solid currentColor;border-radius:6px';
    for (const name of ['Как у сайта', 'Без прокси']) {
      const segment = document.createElement('span');
      segment.textContent = name;
      segment.style.cssText = 'font-size:12px;line-height:18px;padding:4px 8px;text-align:center;white-space:nowrap';
      control.append(segment);
    }
    const help = document.createElement('p');
    help.className = 'policy-help-reference';
    help.style.cssText = 'margin:0;font-size:11px;line-height:16px';
    help.textContent = 'Ручные исключения сохраняются.';
    policy.append(text, control, help);
    document.querySelector('#popupView details').before(site, policy);
  });
  // This is a visual fixture, not a fabricated extension backend: both DOMs
  // receive identical sample text so geometry is independent of routing state.
  await actual.evaluate(() => {
    document.getElementById('siteCard').hidden = false;
    document.getElementById('domain').textContent = 'example.test';
    document.getElementById('status').textContent = 'Включено';
    document.getElementById('status').classList.add('active');
    document.getElementById('route').textContent = 'Маршрут выбирает PAC';
    document.getElementById('actionScope').textContent = 'Ручного правила нет. Используется выбранный PAC-скрипт.';
    document.getElementById('resourceCount').textContent = '3 домена';
    const select = document.createElement('select');
    select.id = 'siteRoute'; select.className = 'site-proxy';
    select.add(new Option('Автоматически — по PAC', '@pac'));
    document.getElementById('siteProxyWrap').replaceChildren(select);
    document.getElementById('siteProxyWrap').hidden = false;
  });
  const differences = [];
  for (const theme of ['light', 'dark']) {
    for (const page of [ref, actual]) await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const expected = await metrics(ref, true), result = await metrics(actual, false);
    for (const [name] of mapping) {
      if (!result[name]) { differences.push(`${theme}/${name}: missing`); continue; }
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Math.abs(expected[name][key] - result[name][key]) > 0.6) differences.push(`${theme}/${name}/${key}: ${result[name][key]} != ${expected[name][key]}`);
      }
      for (const key of ['fontSize', 'fontWeight', 'lineHeight', 'borderRadius', 'padding']) {
        if (expected[name][key] !== result[name][key]) differences.push(`${theme}/${name}/${key}: ${result[name][key]} != ${expected[name][key]}`);
      }
    }
    await ref.bringToFront();
    await (await ref.$('#popupView')).screenshot({ path: path.join(output, `popup-reference-${theme}.png`) });
    await actual.bringToFront();
    await (await actual.$('body')).screenshot({ path: path.join(output, `popup-production-${theme}.png`) });
    fs.writeFileSync(path.join(output, `popup-metrics-${theme}.json`), JSON.stringify({ expected, actual: result }, null, 2));
  }
  fs.writeFileSync(path.join(output, 'popup-differences.json'), JSON.stringify(differences, null, 2));
  assert.deepEqual(differences, [], differences.join('\n'));
  console.log(`Popup 01 + approved simplified controls fidelity PASS: ${mapping.length} components, exact fonts/paddings/radii and geometry within 0.6px, both themes.`);
} finally { await browser.close(); }
