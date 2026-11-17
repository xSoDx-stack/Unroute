import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { checkDomainListsNative } from './domain-lists-native-checks.js';

export async function verifyDomainListsNative(browser, page) {
  const received = [];
  const probeSnapshots = [];
  const servers = ['origin-direct', 'own-proxy', 'second-proxy'].map(label => http.createServer((req, res) => {
    received.push({ target: label, url: req.url });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'close');
    res.end(label);
  }));
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const port = servers[0].address().port;
  await page.exposeFunction('probeDomainListsNative', async (host, label, resource, route) => {
    probeSnapshots.push({ label, state: await page.evaluate(() => chrome.storage.local.get('pac-kitchen-mods')) });
    const tab = await browser.newPage();
    try {
      const url = `http://${host}:${port}/domain-lists-${label}-${Date.now()}`;
      let response = await tab.goto(url, { waitUntil: 'domcontentloaded' });
      if (route) {
        const result = await page.evaluate(async ({ url, route, host }) => {
          const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
          const tabId = tabs.find(tab => tab.url === url).id;
          const snapshot = await new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_DOMAIN_LISTS' }, resolve));
          return new Promise(resolve => chrome.runtime.sendMessage({ action: 'SET_SITE_ROUTE', ...route, currentTabId: tabId,
            expectedHost: host, expectedRevision: snapshot.data.revision }, resolve));
        }, { url, route, host });
        assert.equal(result?.success, true, JSON.stringify(result));
        response = await tab.goto(url + '-after-manual', { waitUntil: 'domcontentloaded' });
      }
      if (!resource) return await response.text();
      if (label === 'automatic-resource-inherits-list') {
        await tab.evaluate(async url => (await fetch(url, { cache: 'no-store' })).text(),
          `http://native-list-cdn.test:${port}/domain-lists-prime-${Date.now()}`);
        await page.waitForFunction(() => new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' },
          response => resolve(response?.data?.exceptions?.['native-list-cdn.test'] === true))), { polling: 50, timeout: 15000 }).catch(async error => {
          error.message += '\nNative list resource diagnostics: ' + JSON.stringify(await page.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_STATE', includeExceptions: true }, resolve))));
          throw error;
        });
      }
      return await tab.evaluate(async url => (await fetch(url, { cache: 'no-store' })).text(),
        `http://native-list-cdn.test:${port}/domain-lists-${label}-resource-${Date.now()}`);
    } finally { await tab.close(); await page.bringToFront(); }
  });
  let failure = null;
  let snapshots = null;
  try {
    // Navigate away from a manual editor left active by earlier scenarios.
    await page.$eval('[data-tab="pac"]', node => node.click());
    const proofs = await page.evaluate(checkDomainListsNative, { proxyPort: servers[1].address().port, secondProxyPort: servers[2].address().port });
    assert.ok(proofs.length >= 9);
    for (const proof of proofs) {
      const matches = received.filter(item => item.url.includes(`/domain-lists-${proof.label}-`) &&
        (!proof.label.startsWith('manual-root-') || item.url.endsWith('-after-manual')) &&
        (!proof.resource || item.url.includes(`/domain-lists-${proof.label}-resource-`)));
      assert.ok(matches.length && matches.every(item => item.target === proof.expected), `Server-side proof: ${proof.label}`);
    }
    const output = path.resolve('artifacts/browser'); fs.mkdirSync(output, { recursive: true });
    const locale = process.env.UNROUTE_TEST_LOCALE || 'ru';
    fs.writeFileSync(path.join(output, `chrome-domain-lists-${locale}.json`), JSON.stringify({ proofs, received }, null, 2));
    console.log(`Chrome domain lists native PASS: ${proofs.length} real network probes, import/scoped editor/toggle/reorder/delete, duplicate independence, manual/bypass/resource overrides, stale revision rejection.`);
  } catch (error) {
    failure = error.stack;
    throw error;
  } finally {
    snapshots = await page.evaluate(async () => ({ storage: await chrome.storage.local.get('pac-kitchen-mods'), proofs: window.domainListsNativeProofs }));
    const output = path.resolve('artifacts/browser'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `chrome-domain-lists-${process.env.UNROUTE_TEST_LOCALE || 'ru'}-network.json`),
      JSON.stringify({ failure, received, snapshots, probeSnapshots }, null, 2));
    await page.removeExposedFunction('probeDomainListsNative');
    await Promise.all(servers.map(server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }));
  }
}
