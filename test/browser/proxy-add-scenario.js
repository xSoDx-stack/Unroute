import assert from 'node:assert/strict';

export async function verifyProxyAddition(page, worker, proxy, credentials) {
  const polling = { polling: 50, timeout: 20000 };
  const base = new URL('index.html#proxies', page.url()).href;
  const send = message => page.evaluate(payload => new Promise(resolve => chrome.runtime.sendMessage(payload, resolve)), message);
  const expectBadge = text => page.waitForFunction(expected => new Promise(resolve => {
    chrome.tabs.getCurrent(tab => chrome.action.getBadgeText({ tabId: tab.id }, value => resolve(value === expected)));
  }), polling, text);
  const previous = (await send({ action: 'GET_STATE' })).data.pacMods;
  await worker.evaluate(async () => {
    const { proxyBackend, pacSync, appState } = globalThis.__proxyTestHooks;
    await appState.ensureInitialized();
    const fixture = globalThis.proxyAddFixture = { apply: proxyBackend.applyPac, restore: proxyBackend.restore,
      init: pacSync.init,
      installs: 0, restores: 0, initsDuringProbe: 0, inProbe: false, holdCommit: true };
    proxyBackend.applyPac = async function(data, options) {
      if (data.includes('var __originalFindProxyForURL')) fixture.inProbe = true;
      else if (fixture.holdCommit) {
        fixture.holdCommit = false;
        await new Promise(resolve => { fixture.releaseCommit = resolve; });
      }
      if (fixture.failNext) { fixture.failNext = false; throw new Error('Fixture native apply failure'); }
      fixture.installs++;
      return fixture.apply.call(this, data, options);
    };
    proxyBackend.restore = async function(details) {
      fixture.restores++;
      try { return await fixture.restore.call(this, details); }
      finally { fixture.inProbe = false; }
    };
    pacSync.init = async function() {
      if (fixture.inProbe) fixture.initsDuringProbe++;
      return fixture.init.call(this);
    };
    appState.reset();
    pacSync.isInitialized = false;
  });
  try {
    await page.bringToFront();
    await page.goto(base);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#tab-proxies.active') && document.getElementById('extVersion').textContent, polling);
    await page.evaluate(({ port, username, password }) => {
      const fixture = window.proxyAddUi = { original: chrome.runtime.sendMessage.bind(chrome.runtime), adds: 0, warnings: 0 };
      fixture.observer = new MutationObserver(() => { if (!document.getElementById('applicationBanner').hidden) fixture.warnings++; });
      fixture.observer.observe(document.getElementById('applicationBanner'), { attributes: true, attributeFilter: ['hidden'] });
      chrome.runtime.sendMessage = (message, callback) => {
        if (message.action === 'ADD_PROXY') fixture.adds++;
        return fixture.original(message, response => {
          if (message.action === 'ADD_PROXY') fixture.releaseAck = () => callback(response);
          else if (message.action === 'GET_STATE' && fixture.holdState) {
            fixture.holdState = false;
            fixture.releaseState = () => callback(response);
          } else callback(response);
        });
      };
      document.getElementById('proxyProtocol').value = 'HTTP';
      document.getElementById('proxyProtocol').dispatchEvent(new Event('change'));
      document.getElementById('proxyHost').value = '127.0.0.1';
      document.getElementById('proxyPort').value = String(port);
      if (!document.getElementById('proxyAuthCheck').checked) document.getElementById('proxyAuthCheck').click();
      document.getElementById('proxyUser').value = username;
      document.getElementById('proxyPass').value = password;
      document.getElementById('addProxyBtn').click();
    }, { port: proxy.port, ...credentials });
    const deadline = Date.now() + 20000;
    while (!await worker.evaluate(() => Boolean(globalThis.proxyAddFixture.releaseCommit))) {
      if (Date.now() > deadline) throw new Error('Proxy add did not reach native commit');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await page.$eval('#addProxyBtn', button => button.disabled), true);
    const applying = (await send({ action: 'GET_STATE' })).settingsState;
    assert.equal(applying.applying, true);
    assert.equal(await page.$eval('#applicationBanner', banner => banner.hidden), true, 'Normal apply must not flash a warning');
    await worker.evaluate(() => globalThis.proxyAddFixture.releaseCommit());
    await page.waitForFunction(() => window.proxyAddUi.releaseAck, polling);
    await page.evaluate(() => {
      window.proxyAddUi.holdState = true;
      document.getElementById('proxyProtocol').value = 'HTTPS';
      document.getElementById('proxyProtocol').dispatchEvent(new Event('change'));
      document.getElementById('proxyAuthCheck').click();
      window.proxyAddUi.releaseAck();
    });
    await page.waitForFunction(() => window.proxyAddUi.releaseState, polling);
    await page.$eval('#addProxyBtn', button => button.click());
    assert.equal(await page.evaluate(() => window.proxyAddUi.adds), 1, 'Add stays locked until authoritative state is loaded');
    assert.equal(await page.$eval('#addProxyBtn', button => button.disabled), true);
    await page.evaluate(() => window.proxyAddUi.releaseState());
    await page.waitForFunction(() => !document.getElementById('addProxyBtn').disabled && document.querySelector('#proxyCardsList .proxy-status-tag.online'), polling);
    assert.equal(await page.$eval('#proxyHost', input => input.value), '127.0.0.1', 'Changing protocol/auth during the check must preserve the new form draft');
    assert.equal(await page.$eval('#proxyProtocol', input => input.value), 'HTTPS');
    assert.equal(await page.$eval('#proxyAuthCheck', input => input.checked), false);
    assert.equal(await page.evaluate(() => window.proxyAddUi.warnings), 0);
    const calls = await worker.evaluate(() => ({ installs: globalThis.proxyAddFixture.installs,
      restores: globalThis.proxyAddFixture.restores, duringProbe: globalThis.proxyAddFixture.initsDuringProbe }));
    assert.deepEqual(calls, { installs: 2, restores: 1, duringProbe: 0 }, 'A probe and final commit must not cause redundant PAC recovery');
    await page.evaluate(() => { chrome.runtime.sendMessage = window.proxyAddUi.original; window.proxyAddUi.observer.disconnect(); delete window.proxyAddUi; });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#proxyCardsList .proxy-status-tag.online'), polling);
    const writes = await worker.evaluate(async () => {
      const { pacSync } = globalThis.__proxyTestHooks;
      const fixture = globalThis.proxyAddFixture;
      const before = fixture.installs;
      await pacSync.applyPacData(pacSync.rawPacData);
      return fixture.installs - before;
    });
    assert.equal(writes, 0, 'Identical native PAC must not be installed again');
    await send({ action: 'CLEAR_PAC' });
    await expectBadge('');
    const beforeEnable = await worker.evaluate(() => globalThis.proxyAddFixture.installs);
    const enabled = await send({ action: 'INSTALL_PAC', key: 'onlyOwnSites' });
    assert.equal(enabled.success, true);
    assert.equal(await worker.evaluate(() => globalThis.proxyAddFixture.installs) - beforeEnable, 1,
      'Enabling own-sites mode must install its PAC only once');
    await worker.evaluate(() => { globalThis.proxyAddFixture.failNext = true; });
    const failed = await send({ action: 'SAVE_MODS', mods: { ifProxyHttpsUrlsOnly: !previous.ifProxyHttpsUrlsOnly } });
    assert.equal(failed.settingsState.pending, true);
    await expectBadge('!');
    await page.waitForFunction(() => !document.getElementById('applicationBanner').hidden && document.getElementById('applicationBanner').textContent.includes('Fixture native apply failure'), polling);
    await page.$eval('#applicationBanner button', button => button.click());
    await page.waitForFunction(() => document.getElementById('applicationBanner').hidden, polling);
    await expectBadge('');
    console.log('Chrome proxy add passed: checked status survives reload, busy gating, no transient warning, real failure/retry, no duplicate native PAC installs.');
  } finally {
    await worker.evaluate(async () => {
      const fixture = globalThis.proxyAddFixture;
      const { proxyBackend, pacSync, whenProxySettingsIdle } = globalThis.__proxyTestHooks;
      fixture.releaseCommit?.();
      await whenProxySettingsIdle();
      proxyBackend.applyPac = fixture.apply; proxyBackend.restore = fixture.restore;
      pacSync.init = fixture.init;
      delete globalThis.proxyAddFixture;
    });
    await page.evaluate(() => {
      if (window.proxyAddUi) {
        window.proxyAddUi.releaseState?.();
        window.proxyAddUi.releaseAck?.();
        chrome.runtime.sendMessage = window.proxyAddUi.original;
        window.proxyAddUi.observer.disconnect(); delete window.proxyAddUi;
      }
    });
    await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: previous.customProxyStringRaw,
      ifProxyHttpsUrlsOnly: previous.ifProxyHttpsUrlsOnly } });
  }
}
