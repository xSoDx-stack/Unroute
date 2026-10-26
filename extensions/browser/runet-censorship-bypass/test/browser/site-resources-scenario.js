import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export async function verifySiteResources(browser, optionsPage, proxy, credentials) {
  const polling = { polling: 100, timeout: 15000 };
  const click = (selector) => optionsPage.evaluate((target) => document.querySelector(target).click(), selector);
  const checkSelectedMode = async (selectedId) => {
    // Background pages may pause CSS transitions; inspect the settled style.
    await optionsPage.evaluate(() => document.querySelectorAll('.site-widget-actions .btn')
      .forEach(button => { button.style.transition = 'none'; }));
    await optionsPage.waitForFunction((id) => {
      const selected = document.getElementById(id);
      const expected = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
      const probe = document.createElement('span');
      probe.style.backgroundColor = expected;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return getComputedStyle(selected).backgroundColor === color;
    }, polling, selectedId);
    const buttons = await optionsPage.evaluate(() =>
      ['setSiteProxyBtn', 'setSiteDirectBtn', 'resetSitePacBtn'].map((id) => {
        const button = document.getElementById(id);
        return { id, pressed: button.getAttribute('aria-pressed'),
          display: getComputedStyle(button).display,
          background: getComputedStyle(button).backgroundColor };
      }));
    assert.deepEqual(buttons.filter(b => b.pressed === 'true').map(b => b.id), [selectedId]);
    assert.ok(buttons.every(b => b.display !== 'none'));
    const selected = buttons.find(b => b.id === selectedId);
    assert.ok(buttons.filter(b => b.id !== selectedId).every(b => b.background !== selected.background));
  };
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/') {
      const port = server.address().port;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<html><body><h1>Resource routing fixture</h1>
        <img src="http://images.cdn.test:${port}/image">
        <script src="http://api.cdn.test:${port}/script"></script></body></html>`);
    } else if (request.url === '/script') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end('window.fixtureReady = true;');
    } else if (request.url === '/image') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>');
    } else response.end('origin-direct');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const send = (message) => optionsPage.evaluate((payload) => new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, resolve);
  }), message);
  let site;
  let probe;
  try {
    assert.equal((await send({ action: 'SAVE_MODS', mods: {
      exceptions: {}, ifUseSecureProxiesOnly: false,
      customProxyStringRaw: `HTTP ${credentials.username}:${credentials.password}@127.0.0.1:${proxy.port}`,
    } })).success, true);
    assert.equal((await send({ action: 'SET_RAW_PAC',
      pacData: 'function FindProxyForURL() { return "DIRECT"; }' })).success, true);
    site = await browser.newPage();
    await site.goto(`http://site.example.test:${port}/`);
    await site.waitForFunction(() => window.fixtureReady === true, polling);
    const tabId = await optionsPage.evaluate(() => new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => resolve(tabs.find((tab) => tab.url?.includes('site.example.test'))?.id));
    }));
    assert.ok(Number.isInteger(tabId));
    const state = await send({ action: 'GET_STATE', currentDomain: 'example.test', currentTabId: tabId });
    assert.ok(state.data.siteResources.hosts.includes('images.cdn.test'));
    assert.ok(state.data.siteResources.hosts.includes('api.cdn.test'));
    await site.bringToFront();
    await optionsPage.reload();
    await optionsPage.waitForFunction(() => document.getElementById('currentSiteDomainText').textContent === 'example.test', polling);
    await checkSelectedMode('resetSitePacBtn');
    await click('#setSiteProxyBtn');
    await optionsPage.waitForFunction(() => document.getElementById('setSiteProxyBtn').getAttribute('aria-pressed') === 'true' &&
      !document.getElementById('setSiteProxyBtn').disabled, polling);
    let rules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    await checkSelectedMode('setSiteProxyBtn');
    assert.equal(rules['images.cdn.test'], true);
    assert.equal(rules['api.cdn.test'], true);
    probe = await browser.newPage();
    let response = await probe.goto(`http://images.cdn.test:${port}/probe`);
    assert.equal(await response.text(), proxy.marker);
    await probe.close();
    probe = null;

    await site.bringToFront();
    await click('#setSiteDirectBtn');
    await optionsPage.waitForFunction(() => document.getElementById('setSiteDirectBtn').getAttribute('aria-pressed') === 'true' &&
      !document.getElementById('setSiteDirectBtn').disabled, polling);
    rules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    assert.equal(rules['images.cdn.test'], false);
    assert.equal(rules['api.cdn.test'], false);
    await site.evaluate((url) => fetch(url).then((res) => res.text()), `http://late.cdn.test:${port}/probe`);
    await optionsPage.waitForFunction(() => new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' }, (res) => resolve(res?.data?.exceptions?.['late.cdn.test'] === false));
    }), polling);
    probe = await browser.newPage();
    response = await probe.goto(`http://images.cdn.test:${port}/probe`);
    assert.equal(await response.text(), 'origin-direct');
    await probe.close();
    probe = null;
    await site.bringToFront();
    await optionsPage.reload();
    await optionsPage.waitForFunction(() => document.getElementById('currentSiteDomainText').textContent === 'example.test', polling);
    await click('#siteResourceDetails summary');
    await optionsPage.setViewport({ width: 420, height: 860, deviceScaleFactor: 1 });
    const imageDir = path.resolve('../../../store-artifacts/ui-check');
    fs.mkdirSync(imageDir, { recursive: true });
    await optionsPage.screenshot({ path: path.join(imageDir, 'site-resources.png') });
    await checkSelectedMode('setSiteDirectBtn');
    await click('#resetSitePacBtn');
    await optionsPage.waitForFunction(() => !document.getElementById('resetSitePacBtn').disabled &&
      document.getElementById('setSiteDirectBtn').getAttribute('aria-pressed') === 'false', polling);
    rules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    assert.equal(rules['images.cdn.test'], undefined);
    assert.equal(rules['late.cdn.test'], undefined);
    await checkSelectedMode('resetSitePacBtn');
    console.log('Whole-site routing passed: discovery, UI, proxy/direct traffic, late resources, and reset.');
  } finally {
    if (probe) await probe.close();
    if (site) await site.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
