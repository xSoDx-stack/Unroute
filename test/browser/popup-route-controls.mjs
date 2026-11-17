// Source native-select behavior, not installed-extension/network proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Native route controls</title>'); return; }
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(path.join(root, 'src') + path.sep)) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const noProfiles = await page.evaluate(async () => {
    const module = await import('/src/common/pages/popup/resource-proxies.js');
    if (!module.siteRouteSelect) return { available: false };
    const calls = [];
    const select = module.siteRouteSelect('example.test', { mode: 'pac' }, [], value => calls.push(value));
    document.body.append(select);
    const before = select.value;
    select.value = '@direct'; select.dispatchEvent(new Event('change'));
    return { available: true, tag: select.tagName, before, value: select.value, calls,
      options: [...select.options].map(option => [option.value, option.disabled]), label: select.getAttribute('aria-label') };
  });
  assert.equal(noProfiles.available, true, 'one site route selector must exist even without own profiles');
  assert.deepEqual(noProfiles.options, [['@pac', false], ['@direct', false]]);
  assert.equal(noProfiles.tag, 'SELECT');
  assert.equal(noProfiles.before, '@pac');
  assert.equal(noProfiles.value, '@pac', 'keep confirmed value while the request is pending');
  assert.deepEqual(noProfiles.calls, ['@direct']);
  assert.match(noProfiles.label, /Подключение сайта/);
  console.log('PASS single native site route selector: zero profiles, PAC/direct and confirmed state');
  const automatic = await page.evaluate(async () => {
    const module = await import('/src/common/pages/popup/resource-proxies.js');
    const calls = [];
    const select = module.resourceProxySelect('cdn.example.test', { mode: 'direct', origin: 'site' }, [],
      (_host, value) => calls.push(value));
    select.id = 'scopeProbe';
    const scope = document.createElement('p');
    scope.id = 'scope'; scope.hidden = true;
    scope.textContent = 'Ручное правило ресурса действует для этого домена во всех вкладках.';
    document.body.append(scope, select);
    const before = { value: select.value, text: select.selectedOptions[0].textContent,
      disabled: select.selectedOptions[0].disabled, title: select.title,
      description: select.getAttribute('aria-description') };
    select.dispatchEvent(new Event('change'));
    select.value = '@direct'; select.dispatchEvent(new Event('change'));
    return { before, value: select.value, calls };
  });
  assert.equal(automatic.before.value, '@automatic');
  assert.equal(automatic.before.text, 'Автоматически');
  assert.equal(automatic.before.disabled, true);
  assert.match(automatic.before.title, /Без прокси/);
  assert.match(automatic.before.title, /во всех вкладках/, 'scope must be available without the removed route status line');
  assert.match(automatic.before.description, /во всех вкладках/);

  const protocol = await page.createCDPSession();
  const document = await protocol.send('DOM.getDocument');
  const { nodeId } = await protocol.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#scopeProbe' });
  const { nodes } = await protocol.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  assert.match(nodes[0].description.value, /во всех вкладках/, 'native accessibility description must expose the global manual-rule scope');
  assert.match(nodes[0].description.value, /Настроено: Без прокси/, 'generic scope must not replace the actual configured route');
  assert.match(nodes[0].description.value, /Следует общей настройке ресурсов сайта/, 'route provenance must remain accessible');
  await protocol.detach();
  assert.deepEqual(automatic.calls, ['@direct'], 'automatic UI sentinel must never be sent as a proxy ID');
  assert.equal(automatic.value, '@automatic');
  console.log('PASS automatic resource label with truthful configured-route tooltip and no sentinel RPC');
  const edge = await page.evaluate(async () => {
    const module = await import('/src/common/pages/popup/resource-proxies.js');
    const catalog = [{ id: 'a', name: 'Рабочий прокси', enabled: true }, { id: 'b', name: 'Отключённый', enabled: false }];
    const snapshot = select => ({ value: select.value, text: select.selectedOptions[0].textContent,
      disabled: select.selectedOptions[0].disabled, values: [...select.options].map(option => option.value) });
    const calls = [];
    const legacy = module.siteRouteSelect('example.test', { mode: 'proxy' }, catalog, value => calls.push(value));
    const missing = module.siteRouteSelect('example.test', { mode: 'proxy', proxyId: 'missing' }, catalog, value => calls.push(value));
    const current = module.siteRouteSelect('example.test', { mode: 'proxy', proxyId: 'a' }, catalog, value => calls.push(value));
    legacy.dispatchEvent(new Event('change'));
    missing.value = ''; missing.dispatchEvent(new Event('change'));
    const auto = module.resourceProxySelect('cdn.test', { mode: 'proxy', proxyId: 'a', origin: 'site' }, catalog,
      (_host, value) => calls.push(value));
    const autoBefore = snapshot(auto);
    auto.value = 'a'; auto.dispatchEvent(new Event('change'));
    const unavailable = module.resourceProxySelect('cdn.test', { mode: 'proxy', proxyId: 'missing', origin: 'site' }, catalog, () => {});
    const manual = module.resourceProxySelect('cdn.test', { mode: 'proxy', proxyId: 'a', origin: 'manual', canResetExact: true }, catalog, () => {});
    return { legacy: snapshot(legacy), missing: snapshot(missing), current: snapshot(current), calls,
      autoBefore, autoAfter: auto.value, unavailable: snapshot(unavailable),
      reset: [...manual.options].find(option => option.value === '@reset-exact')?.textContent };
  });
  assert.equal(edge.current.value, 'a');
  assert.equal(edge.current.text, 'Прокси: Рабочий прокси');
  assert.deepEqual(edge.current.values, ['@pac', '@direct', 'a']);
  assert.deepEqual(edge.legacy, { value: '@legacy', text: 'Общий список прокси', disabled: true, values: ['@pac', '@direct', '@legacy', 'a'] });
  assert.equal(edge.missing.value, 'missing');
  assert.equal(edge.missing.disabled, true);
  assert.equal(edge.autoBefore.value, '@automatic');
  assert.equal(edge.autoBefore.text, 'Автоматически');
  assert.equal(edge.autoAfter, '@automatic');
  assert.deepEqual(edge.calls, ['a'], 'read-only/invalid site choices are ignored; choosing the inherited profile is an explicit resource assignment');
  assert.equal(edge.unavailable.value, 'missing');
  assert.equal(edge.unavailable.text, 'Прокси недоступен');
  assert.equal(edge.unavailable.disabled, true);
  assert.equal(edge.reset, 'Убрать исключение');
  console.log('PASS full site name, single enabled profile, read-only legacy/unavailable, invalid input guard, same-profile explicit resource intent and remove-exception label');
} finally {
  try { await browser?.close(); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
