import assert from 'node:assert/strict';
import { sendChromeMessage } from './chrome-rpc.js';
import http from 'node:http';

export async function verifyResourceBatch(browser, page, worker) {
  const send = message => sendChromeMessage(page, message);
  const previous = (await send({ action: 'GET_STATE', includeExceptions: true })).data.pacMods;
  const server = http.createServer((_request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    response.end('<!doctype html><title>Resource batch fixture</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let site;
  try {
    assert.ok(Object.keys(previous.exceptions).length >= 33000);
    const saved = await send({ action: 'SAVE_MODS', mods: {
      exceptions: { ...previous.exceptions, 'example.test': false },
      customProxyStringRaw: 'HTTP 127.0.0.1:9', ifUseSecureProxiesOnly: false,
    } });
    assert.equal(saved.success, true);
    await worker.evaluate(() => {
      const { pacKitchen, proxyBackend } = globalThis.__proxyTestHooks;
      const fixture = globalThis.resourceBatchFixture = {
        update: pacKitchen.updatePacMods, apply: proxyBackend.applyPac,
        batches: 0, writes: 0, preservedHistory: true, preservedMetadata: true,
      };
      pacKitchen.updatePacMods = async function(mutator, context) {
        const before = await this.getRawPacMods();
        const result = await fixture.update.call(this, mutator, context);
        if (context?.source === 'auto') {
          const after = await this.getRawPacMods();
          fixture.batches++;
          fixture.preservedHistory &&= after.ruleHistory[1] === before.ruleHistory[0];
          fixture.preservedMetadata &&= before.ruleMeta['exception:domain-0.example.com'] ===
            after.ruleMeta['exception:domain-0.example.com'];
        }
        return result;
      };
      proxyBackend.applyPac = async function(...args) {
        fixture.writes++;
        return fixture.apply.apply(this, args);
      };
    });
    site = await browser.newPage();
    await site.goto(`http://site.example.test:${port}/`);
    await site.evaluate(async fixturePort => {
      await Promise.all(Array.from({ length: 30 }, (_, index) =>
        fetch(`http://batch-${index}.cdn.test:${fixturePort}/resource`)));
    }, port);
    await page.waitForFunction(() => new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' }, response =>
        resolve(response?.data?.exceptions?.['batch-29.cdn.test'] === false));
    }), { polling: 100, timeout: 20000 });
    await page.waitForFunction(() => new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'GET_STATE' }, response =>
        resolve(response?.data?.settingsState && !response.data.settingsState.pending &&
          !response.data.settingsState.applying));
    }), { polling: 100, timeout: 20000 });
    await worker.evaluate(() => globalThis.__proxyTestHooks.whenProxySettingsIdle());
    const result = await worker.evaluate(() => {
      const fixture = globalThis.resourceBatchFixture;
      return { batches: fixture.batches, writes: fixture.writes,
        preservedHistory: fixture.preservedHistory, preservedMetadata: fixture.preservedMetadata };
    });
    assert.equal(result.batches, 1, 'Thirty newly discovered hosts must share a single rule update');
    assert.equal(result.writes, 1, 'A single resource batch must install its native PAC only once');
    assert.equal(result.preservedHistory, true, 'Automatic edits must retain untouched history objects');
    assert.equal(result.preservedMetadata, true, 'Automatic edits must retain untouched metadata objects');
    console.log('Chrome resource batch passed: 33000 rules, 30 new hosts, one native PAC update, retained metadata/history.');
  } finally {
    try {
      await worker.evaluate(() => {
        const fixture = globalThis.resourceBatchFixture;
        if (!fixture) return;
        const { pacKitchen, proxyBackend } = globalThis.__proxyTestHooks;
        pacKitchen.updatePacMods = fixture.update;
        proxyBackend.applyPac = fixture.apply;
        delete globalThis.resourceBatchFixture;
      }).catch(() => {});
      if (site) await site.close();
      const restore = Object.fromEntries(Object.entries(previous).filter(([key]) => ![
        'proxyProfiles', 'proxyCatalog', 'domainProxyIds', 'defaultProxyId', 'proxyCatalogRevision',
        'rulesRevision', 'exceptionStats', 'ruleMeta', 'ruleHistory',
      ].includes(key)));
      assert.equal((await send({ action: 'SAVE_MODS', mods: restore })).success, true);
    } finally {
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  }
}
