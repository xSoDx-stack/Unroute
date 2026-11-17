/* global fixture */
// Source-DOM proof in Chrome, not an installed-extension/network integration test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'image/png');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const catalog = [{ id: 'a', name: 'First proxy', enabled: true }, { id: 'b', name: '<img src=x onerror=alert(1)>', enabled: true }];
async function open({ targets = catalog, routes = {}, hosts = ['example.test', 'cdn.example.test'], incognito = false, theme = 'light', rulesEnabled = true, siteMatch = {}, inheritResources = true, canInheritResources = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 600 });
  await page.evaluateOnNewDocument(config => {
    window.fixture = { calls: [], tab: { id: 7, url: 'https://example.test/', incognito: config.incognito }, failLoad: false, failMutation: false, pending: false, hold: false,
      data: { version: 'test', syncState: { currentPacProviderKey: 'own', isControlled: true }, pacMods: { proxyCatalog: config.targets, rulesRevision: 8, ifMindExceptions: config.rulesEnabled },
        currentSiteMatch: config.siteMatch, siteResources: { hosts: config.hosts, count: config.hosts.length, routing: 'tab', routes: config.routes, rulesRevision: 9,
          inheritResources: config.inheritResources, canInheritResources: config.canInheritResources } } };
    const f = window.fixture;
    window.chrome = { i18n: { getMessage: () => '' }, runtime: { getURL: x => x, sendMessage(message, callback) {
      f.calls.push(message);
      if (message.action === 'GET_STATE') { callback(f.failLoad ? { success: false, error: 'load failed' } : { success: true, data: structuredClone(f.data) }); return; }
      const finish = () => {
        if (f.failMutation) { callback({ success: false, error: 'revision conflict' }); return; }
        if (message.action === 'SET_SITE_ROUTE') {
          f.data.currentSiteMatch = { matched: message.isProxy !== null, isProxied: message.isProxy,
            proxyId: message.isProxy ? message.proxyId || f.data.currentSiteMatch.proxyId || 'a' : null };
          f.data.siteResources.needsReload = true;
        }
        if (message.action === 'SET_SITE_RESOURCE_INHERITANCE') {
          f.data.siteResources.inheritResources = message.enabled;
          f.data.siteResources.needsReload = true;
        }
        if (message.action === 'RESET_RESOURCE_RULE') {
          f.data.siteResources.routes[message.host] = f.resetRoute || { mode: 'proxy', proxyId: 'a', origin: 'site', ruleKey: 'example.test', canResetExact: false };
          f.data.siteResources.needsReload = true;
        }
        for (const op of message.operations || []) f.data.siteResources.routes[op.domain] = { mode: op.mode, proxyId: op.proxyId, origin: 'manual', ruleKey: op.domain, canResetExact: true };
        f.data.siteResources.rulesRevision++;
        f.data.settingsState = { pending: f.pending };
        callback({ success: true, settingsState: { pending: f.pending } });
      };
      if (f.hold) f.release = finish; else finish();
    } }, tabs: { query: (_q, cb) => { if (f.holdQuery) f.releaseQuery = () => cb([f.tab]); else cb([f.tab]); }, reload: (id, _o, cb) => { (f.reloads ||= []).push(id); cb(); }, create() {} },
    storage: { local: { get: (_keys, cb) => cb({ 'ui-appearance': { theme: config.theme } }) }, onChanged: { addListener(fn) { (f.listeners ||= []).push(fn); } } } };
    f.refresh = () => f.listeners.forEach(fn => fn({ 'pac-kitchen-mods': {} }, 'local'));
  }, { targets, routes, hosts, incognito, theme, rulesEnabled, siteMatch, inheritResources, canInheritResources });
  await page.goto(`http://127.0.0.1:${server.address().port}/src/common/pages/popup/index.html`);
  await page.waitForFunction(() => !document.getElementById('siteCard').hidden);
  await page.$eval('#resourceDetails', el => { el.open = true; });
  return page;
}
const selects = '#resources select';
try {
  // Automatic is UI metadata only: never serialize the sentinel into RPC.
  for (const origin of ['site', 'pac', 'automatic-other']) for (const mode of ['proxy', 'direct', 'pac']) {
    const page = await open({ routes: { 'cdn.example.test': { mode, proxyId: mode === 'proxy' ? 'a' : null, origin } } });
    const selector = '#resources select[data-host="cdn.example.test"]';
    assert.deepEqual(await page.$eval(selector, node => ({ value: node.value, label: node.selectedOptions[0].textContent, disabled: node.selectedOptions[0].disabled })),
      { value: '@automatic', label: 'Автоматически', disabled: true });
    assert.equal(await page.$eval(selector, node => [...node.options].some(option => option.value === '@reset-exact')), false);
    assert.ok(await page.$eval(selector, node => Boolean(node.title)), 'Configured route/provenance stays available in title');
    await page.$eval(selector, node => node.dispatchEvent(new Event('change', { bubbles: true })));
    assert.equal(await page.evaluate(() => fixture.calls.some(call => call.action === 'MUTATE_DOMAIN_RULES')), false);
    await page.select(selector, mode === 'direct' ? '@direct' : 'a');
    await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
    assert.equal(await page.$eval(selector, node => node.closest('li').dataset.origin), 'manual', 'Same effective route can be pinned explicitly from Automatic');
    assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.action === 'MUTATE_DOMAIN_RULES').length), 1);
    await page.close();
  }
  for (const [siteMatch, value] of [
    [{}, '@pac'], [{ matched: true, isProxied: false }, '@direct'],
    [{ matched: true, isProxied: true }, '@legacy'],
    [{ matched: true, isProxied: true, proxyId: 'gone' }, 'gone'],
    [{ matched: true, isProxied: true, proxyId: 'off' }, 'off'],
  ]) {
    const page = await open({ siteMatch, targets: [...catalog, { id: 'off', name: 'Disabled', enabled: false }] });
    assert.equal(await page.$eval('#siteRoute', node => node.value), value);
    assert.equal(await page.$eval('#siteRoute', node => node.selectedOptions[0].disabled), ['@legacy', 'gone', 'off'].includes(value));
    assert.equal(await page.evaluate(() => fixture.calls.some(call => call.action === 'SET_SITE_ROUTE')), false, 'Rendering never silently falls back or saves');
    assert.equal(await page.$eval('#route', node => node.hidden), true);
    for (const [choice, isProxy] of [['@direct', false], ['@pac', null]]) {
      await page.select('#siteRoute', choice);
      await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
      assert.deepEqual(await page.evaluate(() => fixture.calls.filter(call => call.action === 'SET_SITE_ROUTE').at(-1)), {
        action: 'SET_SITE_ROUTE', domain: 'example.test', currentTabId: 7, isProxy, expectedRevision: choice === '@direct' ? 9 : 10, expectedHost: 'example.test'
      });
    }
    await page.close();
  }
  const mainOnly = await open({ hosts: ['example.test'] });
  assert.equal(await mainOnly.$$eval('#resources li', nodes => nodes.length), 0);
  assert.equal(await mainOnly.$eval('#resourceCount', node => node.textContent), '0');
  assert.equal(await mainOnly.$eval('#resourcesEmpty', node => node.hidden), false);
  await mainOnly.close();
  const fullHost = await open({ hosts: ['example.test', 'www.example.test', 'cdn.example.test'] });
  await fullHost.evaluate(() => { fixture.tab.url = 'https://www.example.test/'; fixture.refresh(); });
  await fullHost.waitForFunction(() => fixture.calls.filter(call => call.action === 'GET_STATE').length === 2);
  assert.deepEqual(await fullHost.$$eval('#resources .resource-domain', nodes => nodes.map(node => node.textContent)), ['cdn.example.test']);
  assert.match(await fullHost.$eval('#resourceCount', node => node.textContent), /^1(?:\D|$)/);
  await fullHost.close();
  for (const identity of ['same-root', 'private']) {
    const page = await open();
    await page.evaluate(() => { window.close = () => { fixture.closed = true; }; });
    await page.click('label[for="directResources"]');
    await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
    await page.evaluate(identity => {
      if (identity === 'same-root') fixture.tab.url = 'https://other.example.test/';
      else fixture.tab.incognito = true;
    }, identity);
    await page.click('#reload');
    await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
    assert.equal(await page.evaluate(() => (fixture.reloads || []).length), 0, identity + ' navigation must prevent stale reload');
    assert.notEqual(await page.evaluate(() => fixture.closed), true);
    await page.close();
  }
  console.log('PASS automatic sentinel/no RPC, same-effective manual pin, site PAC/direct/legacy/unavailable states, filtered root/fullHost counts and stale reload identity guards');
  const manualPage = await open({ routes: { 'example.test': { mode: 'proxy', proxyId: 'a', origin: 'main', canResetExact: false },
    'cdn.example.test': { mode: 'proxy', proxyId: 'a', origin: 'manual', ruleKey: 'cdn.example.test', canResetExact: true } } });
  const manualSelect = '#resources select[data-host="cdn.example.test"]';
  assert.equal(await manualPage.$$eval('.resource-manual', pins => pins.length), 1, 'manual assignment to the SAME parent proxy is still visibly manual');
  assert.match(await manualPage.$eval(manualSelect, select => select.title), /Ручное правило/);
  assert.equal(await manualPage.$eval(manualSelect, select => [...select.options].some(option => option.value === '@reset-exact')), true);
  await manualPage.evaluate(() => { fixture.hold = true; });
  await manualPage.select(manualSelect, '@reset-exact');
  await manualPage.waitForFunction(() => fixture.calls.some(call => call.action === 'RESET_RESOURCE_RULE'));
  assert.deepEqual(await manualPage.evaluate(() => fixture.calls.find(call => call.action === 'RESET_RESOURCE_RULE')), {
    action: 'RESET_RESOURCE_RULE', host: 'cdn.example.test', domain: 'example.test', currentTabId: 7,
    expectedHost: 'example.test', expectedRevision: 9
  });
  assert.equal(await manualPage.$eval(manualSelect, select => select.value === 'a' && select.disabled), true);
  await manualPage.evaluate(() => { fixture.hold = false; fixture.release(); });
  await manualPage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await manualPage.$$eval('.resource-manual', pins => pins.length), 0);
  assert.equal(await manualPage.$eval(manualSelect, select => select.value), '@automatic');
  assert.match(await manualPage.$eval(manualSelect, select => select.title), /настройке ресурсов сайта/);
  assert.equal(await manualPage.$eval('#reload', button => button.hidden), false);
  await manualPage.close();
  const wildcardPage = await open({ routes: { 'cdn.example.test': { mode: 'direct', origin: 'manual', ruleKey: 'cdn.example.test', canResetExact: true } } });
  await wildcardPage.evaluate(() => { fixture.resetRoute = { mode: 'proxy', proxyId: 'b', origin: 'manual', ruleKey: '*.example.test', canResetExact: false }; });
  await wildcardPage.select(manualSelect, '@reset-exact');
  await wildcardPage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await wildcardPage.$$eval('.resource-manual', pins => pins.length), 1, 'resetting an exact rule can reveal an existing MANUAL wildcard');
  assert.match(await wildcardPage.$eval(manualSelect, select => select.title), /\*\.example.test/);
  assert.equal(await wildcardPage.$eval(manualSelect, select => [...select.options].some(option => option.value === '@reset-exact')), false, 'never offer to delete the broad rule as an exact reset');
  await wildcardPage.close();
  const resetFailure = await open({ routes: { 'cdn.example.test': { mode: 'direct', origin: 'manual', ruleKey: 'cdn.example.test', canResetExact: true } } });
  await resetFailure.evaluate(() => { fixture.failMutation = true; });
  await resetFailure.select(manualSelect, '@reset-exact');
  await resetFailure.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await resetFailure.$eval(manualSelect, select => select.value), '@direct');
  assert.equal(await resetFailure.$$eval('.resource-manual', pins => pins.length), 1);
  assert.match(await resetFailure.$eval('#notice', node => node.textContent), /revision conflict/);
  await resetFailure.evaluate(() => { fixture.failMutation = false; fixture.failLoad = true; });
  await resetFailure.select(manualSelect, '@reset-exact');
  await resetFailure.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await resetFailure.$eval(manualSelect, select => select.disabled && select.value === '@direct'), true);
  assert.equal(await resetFailure.$$eval('.resource-manual', pins => pins.length), 1, 'do not remove the pin before confirmed readback');
  await resetFailure.evaluate(() => { fixture.failLoad = false; });
  await resetFailure.click('#retryLoad');
  await resetFailure.waitForFunction(() => !document.querySelector('.resource-manual'));
  await resetFailure.close();
  console.log('PASS metadata-based manual pin (including same profile), exact reset payload, confirmed/busy state and truthful wildcard fallback');
  const modePage = await open();
  assert.equal(await modePage.$$eval('.resource-mode-switch input[type="radio"]', inputs => inputs.length), 2);
  assert.equal(await modePage.$eval('label[for="inheritResources"]', node => node.textContent), 'Как у сайта');
  assert.equal(await modePage.$eval('label[for="directResources"]', node => node.textContent), 'Без прокси');
  await modePage.click('label[for="directResources"]');
  await modePage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await modePage.$eval('#directResources', input => input.checked), true);
  assert.equal(await modePage.$eval('#inheritResources', input => input.checked), false);
  assert.equal(await modePage.$eval('#reload', button => button.hidden), false);
  await modePage.focus('#directResources');
  await modePage.keyboard.press('ArrowLeft');
  await modePage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await modePage.$eval('#inheritResources', input => input.checked && document.activeElement === input), true, 'native radio keyboard navigation retains focus after the confirmed save');
  await modePage.evaluate(() => { window.close = () => { fixture.closed = true; }; fixture.holdQuery = true; });
  assert.equal(await modePage.$eval('#reloadRow', node => node.hidden), false);
  assert.equal(await modePage.$eval('#saveState', node => node.textContent), 'Изменения сохранены');
  assert.equal(await modePage.$eval('#reload', node => node.textContent.trim()), 'Перезагрузить');
  assert.ok(await modePage.$eval('#reload', node => node.getAttribute('aria-label')?.includes('сайт')));
  await modePage.$eval('#reload', button => { button.click(); button.click(); });
  await modePage.waitForFunction(() => typeof fixture.releaseQuery === 'function');
  assert.equal(await modePage.$$eval('select,input[type=radio]', nodes => nodes.every(node => node.disabled)), true, 'reload locks route and policy controls');
  const routeCalls = await modePage.evaluate(() => fixture.calls.filter(call => call.action === 'SET_SITE_ROUTE').length);
  await modePage.$eval('#siteRoute', node => { node.value = '@direct'; node.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await modePage.evaluate(() => fixture.calls.filter(call => call.action === 'SET_SITE_ROUTE').length), routeCalls, 'no route change during reload');
  await modePage.evaluate(() => { fixture.holdQuery = false; fixture.releaseQuery(); });
  await modePage.waitForFunction(() => fixture.closed === true);
  assert.deepEqual(await modePage.evaluate(() => fixture.reloads), [7]);
  await modePage.close();
  const inheritancePage = await open({ siteMatch: { matched: true, isProxied: true, proxyId: 'a' },
    routes: { 'cdn.example.test': { mode: 'proxy', proxyId: 'b' } } });
  assert.equal(await inheritancePage.$eval('#inheritResources', input => input.checked), true);
  assert.equal(await inheritancePage.$$eval('#resources input', inputs => inputs.length), 0, 'there is one site-wide switch, never a per-resource inheritance checkbox');
  await inheritancePage.evaluate(() => { fixture.hold = true; });
  await inheritancePage.click('label[for="directResources"]');
  await inheritancePage.waitForFunction(() => fixture.calls.some(call => call.action === 'SET_SITE_RESOURCE_INHERITANCE'));
  assert.deepEqual(await inheritancePage.evaluate(() => fixture.calls.find(call => call.action === 'SET_SITE_RESOURCE_INHERITANCE')), {
    action: 'SET_SITE_RESOURCE_INHERITANCE', domain: 'example.test', currentTabId: 7,
    enabled: false, expectedRevision: 9, expectedHost: 'example.test'
  });
  assert.equal(await inheritancePage.$eval('#inheritResources', input => input.checked && input.disabled), true, 'keep confirmed state and lock the checkbox until saving/refresh finishes');
  assert.equal(await inheritancePage.$$eval('select', nodes => nodes.every(node => node.disabled)), true);
  await inheritancePage.evaluate(() => { fixture.hold = false; fixture.release(); });
  await inheritancePage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await inheritancePage.$eval('#inheritResources', input => input.checked), false);
  assert.equal(await inheritancePage.$eval('.site-proxy', select => select.value), 'a');
  assert.equal(await inheritancePage.$eval('#resources select[data-host="cdn.example.test"]', select => select.value), 'b', 'manual row remains independent of the global switch');
  assert.equal(await inheritancePage.$eval('#route', node => node.textContent), 'Сайт — через прокси');
  assert.match(await inheritancePage.$eval('#route', node => node.title), /Автоматические ресурсы.*напрямую/);
  await inheritancePage.select('#resources select[data-host="cdn.example.test"]', 'a');
  await inheritancePage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await inheritancePage.$eval('#inheritResources', input => input.checked), false, 'an explicit resource choice must not re-enable global inheritance');
  assert.deepEqual(await inheritancePage.evaluate(() => fixture.calls.find(call => call.action === 'MUTATE_DOMAIN_RULES').operations),
    [{ domain: 'cdn.example.test', mode: 'proxy', proxyId: 'a' }]);
  await inheritancePage.click('label[for="inheritResources"]');
  await inheritancePage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await inheritancePage.$eval('#inheritResources', input => input.checked), true);
  await inheritancePage.evaluate(() => { fixture.failMutation = true; });
  await inheritancePage.click('label[for="directResources"]');
  await inheritancePage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await inheritancePage.$eval('#inheritResources', input => input.checked), true, 'failed save must not turn off inheritance visually');
  assert.match(await inheritancePage.$eval('#notice', node => node.textContent), /revision conflict/);
  await inheritancePage.close();
  const pendingInheritance = await open();
  await pendingInheritance.evaluate(() => { fixture.pending = true; });
  await pendingInheritance.click('label[for="directResources"]');
  await pendingInheritance.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await pendingInheritance.$eval('#inheritResources', input => input.checked), false, 'show saved policy independently from apply status');
  assert.equal(await pendingInheritance.$eval('#applicationBanner', banner => banner.hidden), false);
  assert.equal(await pendingInheritance.$eval('#reload', button => button.hidden && button.disabled), true);
  assert.equal(await pendingInheritance.$eval('#reloadRow', node => node.hidden), true);
  await pendingInheritance.$eval('#reload', button => button.dispatchEvent(new Event('click')));
  assert.equal(await pendingInheritance.evaluate(() => fixture.reloads?.length || 0), 0, 'do not reload before pending rules are applied');
  await pendingInheritance.close();
  const failedReadInheritance = await open();
  await failedReadInheritance.evaluate(() => { fixture.failLoad = true; });
  await failedReadInheritance.click('label[for="directResources"]');
  await failedReadInheritance.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await failedReadInheritance.$eval('#inheritResources', input => input.checked && input.disabled), true, 'a failed confirmation read retains and disables the last confirmed policy');
  assert.equal(await failedReadInheritance.$eval('#loadError', node => node.hidden), false);
  assert.equal(await failedReadInheritance.$eval('#siteRoute', node => node.disabled), true);
  await failedReadInheritance.$eval('#siteRoute', node => { node.value = 'b'; node.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await failedReadInheritance.evaluate(() => fixture.calls.some(call => call.action === 'SET_SITE_ROUTE')), false, 'disabled site selector cannot mutate after failed confirmation read');
  await failedReadInheritance.evaluate(() => { fixture.failLoad = false; });
  await failedReadInheritance.click('#retryLoad');
  await failedReadInheritance.waitForFunction(() => !document.getElementById('inheritResources').checked && !document.getElementById('inheritResources').disabled);
  await failedReadInheritance.close();
  for (const config of [{ incognito: true }, { rulesEnabled: false }, { canInheritResources: false }]) {
    const page = await open(config);
    assert.equal(await page.$eval('#inheritResources', input => input.disabled), true);
    await page.$eval('#inheritResources', input => { input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.evaluate(() => fixture.calls.some(call => call.action === 'SET_SITE_RESOURCE_INHERITANCE')), false);
    assert.equal(await page.$eval('#inheritResources', input => input.checked), true);
    await page.close();
  }
  const staleInheritance = await open();
  await staleInheritance.evaluate(() => { fixture.tab.url = 'https://other.example.test/'; });
  await staleInheritance.click('label[for="directResources"]');
  await staleInheritance.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await staleInheritance.evaluate(() => fixture.calls.some(call => call.action === 'SET_SITE_RESOURCE_INHERITANCE')), false);
  await staleInheritance.close();
  const inheritanceShots = path.join(root, 'artifacts/popup-resource-inheritance');
  fs.mkdirSync(inheritanceShots, { recursive: true });
  for (const theme of ['light', 'dark']) for (const inheritResources of [true, false]) {
    const page = await open({ theme, inheritResources,
      targets: [{ id: 'a', name: 'Основной', enabled: true }, { id: 'b', name: 'Резервный', enabled: true }],
      hosts: ['example.test', 'auto.cdn.test', 'manual.cdn.test'], siteMatch: { matched: true, isProxied: true, proxyId: 'a' },
      routes: { 'example.test': { mode: 'proxy', proxyId: 'a', origin: 'main', canResetExact: false },
        'auto.cdn.test': inheritResources ? { mode: 'proxy', proxyId: 'a', origin: 'site' } : { mode: 'direct', origin: 'site' },
        'manual.cdn.test': { mode: 'proxy', proxyId: 'b', origin: 'manual', ruleKey: 'manual.cdn.test', canResetExact: true } } });
    assert.equal(await page.$eval('#inheritResources', input => input.checked), inheritResources);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 360), true);
    assert.equal(await page.$eval('#resourcePolicyHint', node => node.textContent), 'Ручные исключения сохраняются.');
    assert.equal(await page.$eval('#inheritResourcesLabel', node => node.textContent), 'Автоматические ресурсы');
    assert.equal(await page.$$eval('#resources select', nodes => nodes.length), 2);
    assert.equal(await page.$eval('#resources select[data-host="auto.cdn.test"]', node => node.value), '@automatic');
    await page.screenshot({ path: path.join(inheritanceShots, `${theme}-${inheritResources ? 'on' : 'off'}.png`) });
    await page.close();
  }
  console.log('PASS native vertical resource policy: exact-host/revision payload, confirmed/busy/failure state, manual selectors preserved, private/disabled/stale guards');
  const directPage = await open({ routes: { 'cdn.example.test': { mode: 'proxy', proxyId: 'b' } },
    siteMatch: { matched: true, isProxied: true, proxyId: 'a' } });
  const directSelect = `${selects}[data-host="cdn.example.test"]`;
  assert.equal(await directPage.$eval(directSelect, el => [...el.options].some(option => option.value === '@direct' && !option.disabled)), true,
    'a resource must offer an actionable Direct route alongside proxy profiles');
  await directPage.select(directSelect, '@direct');
  await directPage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.deepEqual(await directPage.evaluate(() => fixture.calls.find(call => call.action === 'MUTATE_DOMAIN_RULES')), {
    action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'cdn.example.test', mode: 'direct' }], expectedRevision: 9
  }, 'Direct is an exact manual domain rule, never a proxy ID or a site-wide switch');
  assert.equal(await directPage.$eval(directSelect, el => el.value), '@direct');
  assert.equal(await directPage.$eval(directSelect, el => el.selectedOptions[0].textContent), 'Без прокси');
  await directPage.select('.site-proxy', 'b');
  await directPage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await directPage.$eval(directSelect, el => el.value), '@direct', 'render confirmed manual Direct independently from the main site target');
  await directPage.select(directSelect, 'a');
  await directPage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.deepEqual(await directPage.evaluate(() => fixture.calls.filter(call => call.action === 'MUTATE_DOMAIN_RULES').at(-1).operations),
    [{ domain: 'cdn.example.test', mode: 'proxy', proxyId: 'a' }], 'Direct can be explicitly replaced by a named proxy');
  await directPage.close();
  console.log('PASS actionable per-resource Direct, exact mutation, confirmed state and proxy reselection');
  const longNames = [{ id: 'a', name: 'Shared prefix — first proxy', enabled: true },
    { id: 'b', name: 'Shared prefix — second proxy', enabled: true }];
  const namesPage = await open({ targets: longNames, siteMatch: { matched: true, isProxied: true, proxyId: 'a' },
    routes: { 'cdn.example.test': { mode: 'proxy', proxyId: 'b' } } });
  assert.equal(await namesPage.$$eval('#siteProxyWrap .proxy-name-label', nodes => nodes.length), 0, 'wide site selector must not have a six-grapheme overlay');
  assert.equal(await namesPage.$eval('#siteRoute', el => el.selectedOptions[0].textContent), 'Прокси: ' + longNames[0].name);
  assert.equal(await namesPage.$eval(`${directSelect} + .proxy-name-label`, el => el.textContent), 'Share…', 'resource selector uses the same compact label');
  assert.deepEqual(await namesPage.$eval(directSelect, el => [...el.options].filter(option => ['a', 'b'].includes(option.value)).map(option => option.textContent)),
    longNames.map(proxy => proxy.name), 'native dropdown retains full names, including proxies with identical short prefixes');
  assert.ok((await namesPage.$eval(directSelect, el => el.title)).includes(longNames[1].name));
  assert.equal(await namesPage.$eval('.proxy-name-label', el => el.getAttribute('aria-hidden')), 'true', 'screen readers use the full native option, not a duplicate shortened label');
  assert.equal(await namesPage.$eval('.proxy-name-control', el => el.getBoundingClientRect().height === el.querySelector('select').getBoundingClientRect().height), true,
    'compact labels must not add inline baseline space to the existing row height');
  const nameShots = path.join(root, 'artifacts/popup-proxy-names');
  fs.mkdirSync(nameShots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    const shotPage = await open({ targets: longNames, theme, siteMatch: { matched: true, isProxied: true, proxyId: 'a' },
      routes: { 'cdn.example.test': { mode: 'proxy', proxyId: 'b' } } });
    assert.equal(await shotPage.evaluate(() => document.documentElement.dataset.theme), theme);
    assert.equal(await shotPage.$eval(directSelect, el => getComputedStyle(el).color), 'rgba(0, 0, 0, 0)', 'only the closed native text is hidden behind the six-character label');
    assert.notEqual(await shotPage.$eval(`${directSelect} option[value="a"]`, el => getComputedStyle(el).color), 'rgba(0, 0, 0, 0)', 'native dropdown entries must remain readable');
    assert.equal(await shotPage.evaluate(() => document.documentElement.scrollWidth <= 360), true);
    await shotPage.screenshot({ path: path.join(nameShots, `popup-${theme}.png`) });
    await shotPage.close();
  }
  await namesPage.select(directSelect, 'a');
  await namesPage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await namesPage.$eval(directSelect, el => el.value), 'a', 'display shortening must never change proxy IDs');
  await namesPage.close();
  for (const [name, expected] of [['123456', '123456'], ['1234567', '12345…'], ['e\u0301'.repeat(7), 'e\u0301'.repeat(5) + '…'],
    ['👩‍💻'.repeat(7), '👩‍💻'.repeat(5) + '…']]) {
    const page = await open({ targets: [{ id: 'a', name, enabled: true }], routes: { 'cdn.example.test': { mode: 'proxy', proxyId: 'a' } } });
    assert.equal(await page.$eval(directSelect, el => el.parentElement.querySelector('.proxy-name-label')?.textContent || el.selectedOptions[0].textContent), expected,
      'six visible characters must not split surrogate pairs, combining marks or ZWJ emoji');
    await page.close();
  }
  console.log('PASS six-grapheme manual resource labels, full-width full-name site control, native dropdown/tooltips, stable IDs and Unicode boundaries');
  const sitePage = await open({ siteMatch: { matched: true, isProxied: true, proxyId: 'a' } });
  assert.equal(await sitePage.$eval('.site-proxy', el => el.value), 'a', 'site target comes from the confirmed binding');
  for (const id of ['actionScope', 'source', 'scope']) assert.equal(await sitePage.$eval(`#${id}`, el => el.hidden), true, `${id} belongs in the status tooltip`);
  assert.match(await sitePage.$eval('#route', el => el.title), /Для всей вкладки/);
  await sitePage.select('.site-proxy', 'b');
  await sitePage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.deepEqual(await sitePage.evaluate(() => fixture.calls.find(call => call.action === 'SET_SITE_ROUTE')), {
    action: 'SET_SITE_ROUTE', domain: 'example.test', currentTabId: 7, isProxy: true, proxyId: 'b', expectedRevision: 9, expectedHost: 'example.test'
  }, 'site selector atomically chooses the proxy for the site with its displayed rules revision');
  assert.equal(await sitePage.$eval('.site-proxy', el => el.value), 'b');
  assert.equal(await sitePage.$eval('#notice', el => el.hidden), true, 'routine saved/reload notice must not duplicate the main status');
  assert.match(await sitePage.$eval('#route', el => el.title), /Перезагрузите сайт/);
  const rightGap = await sitePage.$eval('#resources', el => parseFloat(getComputedStyle(el).paddingRight));
  assert.ok(rightGap >= 10, 'resource controls need padding before the scrollbar');
  await sitePage.select('#siteRoute', '@direct');
  await sitePage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  await sitePage.select('.site-proxy', 'a');
  await sitePage.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await sitePage.evaluate(() => fixture.calls.filter(call => call.action === 'SET_SITE_ROUTE').at(-1).proxyId), 'a', 'proxy mode retains the explicit selected target');
  await sitePage.close();
  const failedSite = await open({ siteMatch: { matched: true, isProxied: true, proxyId: 'b' } });
  await failedSite.evaluate(() => { fixture.hold = true; fixture.failMutation = true; });
  await failedSite.select('.site-proxy', 'a');
  assert.equal(await failedSite.$eval('.site-proxy', el => el.disabled), true);
  assert.equal(await failedSite.$$eval(selects, els => els.every(el => el.disabled)), true);
  await failedSite.evaluate(() => fixture.release());
  await failedSite.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await failedSite.$eval('.site-proxy', el => el.value), 'b', 'failed save must not display an unsaved site target');
  assert.equal(await failedSite.$eval('#notice', el => el.hidden), false, 'errors remain visible, not hidden in hover help');
  await failedSite.evaluate(() => { fixture.tab.url = 'https://other.example.test/'; });
  await failedSite.select('.site-proxy', 'a');
  await failedSite.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await failedSite.evaluate(() => fixture.calls.filter(call => call.action === 'SET_SITE_ROUTE').length), 1, 'navigation must not mutate a stale site');
  await failedSite.close();
  console.log('PASS full-width site route selection, revision/busy/failure/navigation guard, tooltip and resource gutter');
  const page = await open({ routes: { 'cdn.example.test': { mode: 'proxy', proxyId: 'b' } } });
  assert.equal(await page.$$eval(selects, els => els.length), 1, 'the main host is controlled only by the site selector');
  assert.equal(await page.$eval(`${selects}[data-host="cdn.example.test"]`, el => el.value), 'b');
  await page.select(`${selects}[data-host="cdn.example.test"]`, 'a');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await page.evaluate(() => fixture.calls.find(call => call.action === 'MUTATE_DOMAIN_RULES')), {
    action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'cdn.example.test', mode: 'proxy', proxyId: 'a' }], expectedRevision: 9
  }, 'selection saves only the exact resource host with the displayed revision');
  assert.equal(await page.$eval(`${selects}[data-host="cdn.example.test"]`, el => el.value), 'a');
  assert.equal(await page.$eval('#reload', el => el.hidden), false, 'successful resource save offers reload even without summary.needsReload');
  await page.evaluate(() => fixture.refresh());
  await page.waitForFunction(() => fixture.calls.filter(c => c.action === 'GET_STATE').length === 3);
  assert.equal(await page.$eval('#reload', el => el.hidden), false, 'resource reload offer survives storage refresh');
  assert.doesNotMatch(await page.$eval('#scope', el => el.textContent), /Ресурсы следуют режиму вкладки/);
  await page.close();
  console.log('PASS resource selectors, effective assignment and exact host mutation');
  for (const targets of [[], catalog.slice(0, 1), [catalog[0], { ...catalog[1], enabled: false }]]) {
    const page = await open({ targets });
    assert.equal(await page.$$eval(selects, els => els.length), 1, 'Direct remains available without multiple enabled proxy profiles');
    assert.equal(await page.$eval('#siteProxyWrap', el => el.hidden), false, 'site route selector is present even with zero or one enabled profile');
    assert.deepEqual(await page.$eval('#siteRoute', el => [...el.options].slice(0, 2).map(option => option.value)), ['@pac', '@direct']);
    assert.equal(await page.$$eval('[data-mode]', nodes => nodes.length), 0);
    assert.equal(await page.$eval(selects, el => [...el.options].some(option => option.value === '@direct' && !option.disabled)), true);
    await page.close();
  }
  for (const [route, value, label] of [
    [{ mode: 'proxy', proxyId: null }, '', 'Общий список прокси'],
    [{ mode: 'direct', proxyId: null }, '@direct', 'Без прокси'], [{ mode: 'pac', proxyId: null }, '', 'PAC'],
    [{ mode: 'proxy', proxyId: 'gone' }, 'gone', 'Прокси недоступен'],
    [{ mode: 'proxy', proxyId: 'off' }, 'off', 'Прокси недоступен'],
    [{ mode: 'proxy', proxyId: 'gone', origin: 'site' }, 'gone', 'Прокси недоступен'],
    [{ mode: 'proxy', proxyId: 'off', origin: 'automatic-other' }, 'off', 'Прокси недоступен']
  ]) {
    const page = await open({ targets: [...catalog, { id: 'off', name: 'Disabled', enabled: false }], routes: { 'cdn.example.test': route } });
    assert.deepEqual(await page.$eval(selects, el => ({ value: el.value, label: el.selectedOptions[0].textContent, disabled: el.selectedOptions[0].disabled })), { value, label, disabled: route.mode !== 'direct' });
    assert.equal(await page.$eval(selects, el => el.getAttribute('aria-label')), 'Маршрут для cdn.example.test');
    if (route.mode === 'proxy' && !route.proxyId) assert.match(await page.$eval(selects, el => el.title), /не прямое соединение/);
    assert.equal(await page.$eval(selects, el => el.options[el.options.length - 1].textContent), catalog[1].name);
    assert.equal(await page.$$eval('#resources img', els => els.length), 0);
    await page.close();
  }
  console.log('PASS target visibility, direct/PAC/legacy/missing placeholders, text-only names and labels');
  const held = await open({ routes: { 'cdn.example.test': { mode: 'proxy', proxyId: 'b' } } });
  await held.evaluate(() => { fixture.hold = true; fixture.failMutation = true; });
  await held.select(selects, 'a');
  assert.equal(await held.$$eval(selects, els => els.every(el => el.disabled)), true, 'all selectors disabled during mutation');
  assert.equal(await held.$eval('#siteRoute', el => el.disabled), true);
  await held.evaluate(() => fixture.release());
  await held.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await held.$eval(selects, el => el.value), 'b', 'failed write refreshes the true assignment');
  assert.equal(await held.$eval('#notice', el => el.textContent), 'revision conflict');
  await held.evaluate(() => { fixture.failLoad = true; fixture.refresh(); });
  await held.waitForFunction(() => !document.getElementById('loadError').hidden);
  assert.equal(await held.$$eval(selects, els => els.every(el => el.disabled)), true, 'load failure locks stale selectors');
  await held.close();
  const disconnected = await open({ routes: { 'cdn.example.test': { mode: 'proxy', proxyId: 'b' } } });
  await disconnected.evaluate(() => { fixture.failMutation = true; fixture.failLoad = true; });
  await disconnected.select(selects, 'a');
  await disconnected.waitForFunction(() => !document.getElementById('loadError').hidden);
  assert.equal(await disconnected.$eval(selects, el => el.value), 'b', 'failed write plus failed refresh must not display an unsaved assignment');
  await disconnected.evaluate(() => { fixture.failLoad = false; });
  await disconnected.click('#retryLoad');
  await disconnected.waitForFunction(() => document.getElementById('loadError').hidden);
  assert.equal(await disconnected.$$eval(selects, els => els.every(el => !el.disabled)), true, 'retry recovers selector controls');
  await disconnected.close();
  const moved = await open();
  await moved.evaluate(() => { fixture.tab.url = 'https://other.example.test/'; });
  await moved.select(selects, 'a');
  await moved.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await moved.evaluate(() => fixture.calls.filter(call => call.action === 'MUTATE_DOMAIN_RULES').length), 0, 'same-root subdomain navigation must not mutate old resource snapshot');
  await moved.close();
  console.log('PASS busy, RPC/load failures, truthful refresh and stale-site protection');
  const ignored = await open({ rulesEnabled: false });
  assert.equal(await ignored.$$eval(selects, els => els.every(el => el.disabled)), true, 'disabled site rules must block resource selectors');
  assert.match(await ignored.$eval('#scope', el => el.textContent), /Правила сайтов отключены/);
  await ignored.select(selects, 'b');
  assert.equal(await ignored.evaluate(() => fixture.calls.filter(call => call.action === 'MUTATE_DOMAIN_RULES').length), 0, 'disabled rules must not produce an ineffective success');
  await ignored.close();
  const pending = await open();
  await pending.evaluate(() => { fixture.pending = true; delete fixture.data.siteResources.rulesRevision; fixture.refresh(); });
  await pending.waitForFunction(() => fixture.calls.filter(c => c.action === 'GET_STATE').length === 2);
  await pending.select(selects, 'b');
  await pending.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.match(await pending.$eval('#notice', el => el.textContent), /Правила сохранены/);
  assert.equal(await pending.$eval('#applicationBanner', el => el.hidden), false, 'saved but unapplied PAC remains actionable');
  assert.equal(await pending.evaluate(() => fixture.calls.find(c => c.action === 'MUTATE_DOMAIN_RULES').expectedRevision), 8, 'catalog revision is a fallback');
  assert.equal(await pending.$eval('#siteRoute', el => el.value), '@pac', 'resource assignment does not replace the site PAC mode');
  await pending.close();
  const privatePage = await open({ incognito: true, hosts: [] });
  assert.equal(await privatePage.$$eval(selects, els => els.length), 0);
  assert.match(await privatePage.$eval('#resourcesEmpty', el => el.textContent), /приватной вкладке/);
  await privatePage.close();
  const output = path.join(root, 'artifacts/popup-resource-proxies');
  fs.mkdirSync(output, { recursive: true });
  for (const theme of ['light', 'dark']) {
    const page = await open({ theme, hosts: ['a-very-long-resource-domain-with-many-labels.cdn.example.test', ...Array.from({ length: 9 }, (_, i) => `resource-${i}.example.test`)] });
    const metrics = await page.evaluate(() => {
      const list = document.getElementById('resources'), select = list.querySelector('select');
      const bounds = select.getBoundingClientRect();
      return { width: document.body.getBoundingClientRect().width, pageOverflow: document.documentElement.scrollWidth > 360,
        listOverflow: list.scrollWidth > list.clientWidth, maxHeight: getComputedStyle(list).maxHeight, selectWidth: bounds.width,
        selectHeight: bounds.height, bg: getComputedStyle(select).backgroundColor, surface: getComputedStyle(document.body).backgroundColor };
    });
    assert.equal(metrics.width, 360);
    assert.equal(metrics.pageOverflow, false);
    assert.equal(metrics.listOverflow, false, 'resource list must not scroll horizontally');
    assert.equal(metrics.maxHeight, '120px');
    assert.ok(metrics.selectWidth <= 125 && metrics.selectHeight >= 24, `compact native selector: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.bg, metrics.surface, 'native selector follows the current theme tokens');
    await page.screenshot({ path: path.join(output, `${theme}.png`) });
    await page.close();
  }
  console.log('PASS pending PAC, revision fallback, unchanged site mode, private empty list and both 360px themes without horizontal overflow');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
