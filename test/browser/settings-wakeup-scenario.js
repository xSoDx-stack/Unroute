import assert from 'node:assert/strict';

export async function verifyLargeRuleHydration(page, worker) {
  const hydrated = await worker.evaluate(async () => {
    const { pacKitchen, storage } = globalThis.__proxyTestHooks;
    const originalGet = storage.get;
    let reads = 0;
    storage.get = async function(key, ...args) {
      if (key === 'pac-kitchen-mods') reads++;
      return originalGet.call(this, key, ...args);
    };
    try {
      pacKitchen.invalidateCache();
      const started = performance.now();
      const snapshots = await Promise.all(Array.from({ length: 20 }, () =>
        Promise.all([pacKitchen.getRawPacMods(), pacKitchen.getPacMods()])));
      const [raw, parsed] = snapshots[0];
      globalThis.largeRuleEditSnapshot = raw;
      return { reads, elapsedMs: Math.round(performance.now() - started),
        count: Object.keys(raw.exceptions).length,
        shared: snapshots.every(([nextRaw, nextParsed]) => nextRaw === raw && nextParsed === parsed) };
    } finally { storage.get = originalGet; }
  });
  assert.ok(hydrated.count >= 33000);
  assert.equal(hydrated.reads, 1, 'Concurrent cold reads must deserialize the large stored snapshot once');
  assert.equal(hydrated.shared, true, 'Cold readers must share the raw and parsed snapshots');
  const send = message => page.evaluate(payload => new Promise(resolve => chrome.runtime.sendMessage(payload, resolve)), message);
  try {
    const response = await send({ action: 'SET_SINGLE_EXCEPTION', domain: 'hydration-edit.test', isProxy: false });
    assert.equal(response.success, true);
    const preserved = await worker.evaluate(async () => {
      const before = globalThis.largeRuleEditSnapshot;
      const after = await globalThis.__proxyTestHooks.pacKitchen.getRawPacMods();
      return after.ruleHistory[1] === before.ruleHistory[0] &&
        after.ruleMeta['exception:domain-0.example.com'] === before.ruleMeta['exception:domain-0.example.com'];
    });
    assert.equal(preserved, true, 'The normal single-rule command must retain untouched history and metadata');
    console.log(`Chrome large-list hydration passed: ${hydrated.count} rules, 40 concurrent raw/parsed reads, one storage read, ${hydrated.elapsedMs} ms; single edits retain history.`);
  } finally {
    await worker.evaluate(() => { delete globalThis.largeRuleEditSnapshot; });
    await send({ action: 'SET_SINGLE_EXCEPTION', domain: 'hydration-edit.test', isProxy: null });
  }
}

export async function verifySettingsWakeup(browser, page) {
  const polling = { polling: 100, timeout: 15000 };
  const base = new URL('index.html#exceptions', page.url()).href;
  await page.bringToFront();
  await page.goto(base);
  // goto() may only change the hash of an existing editor. Start with a fresh
  // document so refreshes queued by the preceding edits cannot enter this test.
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('manualRulesLink').disabled);
    await page.click('#manualRulesLink');
  await page.waitForSelector('#manualSitesEditor #newDomainInput', { visible: true });
  await page.waitForFunction(() => document.getElementById('includedCount').textContent === '33000', polling);
  const flag = await page.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_STATE' },
    response => resolve(response.data.pacMods.ifProxyHttpsUrlsOnly))));
  await page.evaluate(() => {
    const fixture = window.settingsWakeupFixture = { original: chrome.runtime.sendMessage.bind(chrome.runtime),
      reads: 0, unchanged: 0, full: 0, mutations: 0, inFlight: 0, storageEvents: 0, counts: [] };
    fixture.observer = new MutationObserver(changes => { fixture.mutations += changes.length; });
    fixture.observer.observe(document.getElementById('domainListContainer'), { childList: true, subtree: true });
    fixture.counterObserver = new MutationObserver(() => { fixture.counts.push(document.getElementById('includedCount').textContent); });
    fixture.counterObserver.observe(document.getElementById('includedCount'), { childList: true });
    fixture.storageListener = (changes, area) => {
      if (area === 'local' && changes['pac-kitchen-mods']) fixture.storageEvents++;
    };
    chrome.storage.onChanged.addListener(fixture.storageListener);
    chrome.runtime.sendMessage = (message, callback) => {
      const read = ['GET_STATE', 'GET_EXCEPTIONS'].includes(message.action);
      if (read) { fixture.reads++; fixture.inFlight++; }
      if (message.action === 'GET_EXCEPTIONS' && fixture.failNext) {
        fixture.failNext = false;
        fixture.inFlight--;
        callback({ success: false, error: 'Simulated list refresh failure' });
        return;
      }
      return fixture.original(message, response => {
        const reply = () => {
          if (read) fixture.inFlight--;
          if (message.action === 'GET_EXCEPTIONS') {
            if (response.data.unchanged) fixture.unchanged++;
            else fixture.full++;
          }
          callback(response);
        };
        if (message.action === 'GET_EXCEPTIONS' && !response.data.unchanged && fixture.holdNextFull) {
          fixture.holdNextFull = false;
          fixture.releaseHeld = reply;
        } else reply();
      });
    };
  });
  let other;
  try {
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); });
    try {
      await page.waitForFunction(() => window.settingsWakeupFixture.unchanged >= 1 && !window.settingsWakeupFixture.inFlight, polling);
    } catch (error) {
      const state = await page.evaluate(() => ({ visibility: document.visibilityState,
        reads: window.settingsWakeupFixture.reads, unchanged: window.settingsWakeupFixture.unchanged,
        full: window.settingsWakeupFixture.full, inFlight: window.settingsWakeupFixture.inFlight,
        status: document.getElementById('saveStatusText').textContent }));
      throw new Error(`Initial focus refresh failed: ${JSON.stringify(state)}`, { cause: error });
    }
    assert.equal(await page.evaluate(() => window.settingsWakeupFixture.mutations), 0, 'Unchanged lists must not be redrawn on focus');
    await page.evaluate(() => { window.settingsWakeupFixture.failNext = true; window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => !document.getElementById('retrySitesLoad').hidden, polling);
    await page.$eval('#retrySitesLoad', button => button.click());
    await page.waitForFunction(() => document.getElementById('retrySitesLoad').hidden &&
      !document.getElementById('saveStatusText').classList.contains('error'), polling);
    assert.equal(await page.evaluate(() => window.settingsWakeupFixture.mutations), 0, 'Recovery with the same revision must preserve the list DOM');
    const beforeSave = await page.evaluate(() => window.settingsWakeupFixture.full);
    await page.$eval('#newDomainInput', input => { input.value = 'wake-rules.test'; });
    await page.$eval('#addDomainBtn', button => button.click());
    await page.waitForFunction(value => window.settingsWakeupFixture.full > value &&
      !window.settingsWakeupFixture.inFlight && document.getElementById('saveStatusText').classList.contains('saved'), polling, beforeSave);
    const afterSave = await page.evaluate(() => ({ mutations: window.settingsWakeupFixture.mutations,
      unchanged: window.settingsWakeupFixture.unchanged }));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(value => window.settingsWakeupFixture.unchanged > value && !window.settingsWakeupFixture.inFlight, polling, afterSave.unchanged);
    assert.equal(await page.evaluate(() => window.settingsWakeupFixture.mutations), afterSave.mutations, 'A committed local edit must retain its revision cache');
    other = await browser.newPage();
    await other.goto(new URL('index.html#pac', base).href);
    await other.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'hidden' && !window.settingsWakeupFixture.inFlight, polling);
    const before = await page.evaluate(() => ({ reads: window.settingsWakeupFixture.reads,
      full: window.settingsWakeupFixture.full, unchanged: window.settingsWakeupFixture.unchanged,
      mutations: window.settingsWakeupFixture.mutations }));
    const response = await other.evaluate(value => new Promise(resolve => chrome.runtime.sendMessage({
      action: 'SAVE_MODS', mods: { ifProxyHttpsUrlsOnly: !value },
    }, resolve)), flag);
    assert.equal(response.success, true);
    // Let the storage events and debounce interval run while the document is hidden.
    await other.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
    assert.equal(await page.evaluate(() => window.settingsWakeupFixture.reads), before.reads, 'Hidden settings must defer background refreshes');
    await page.bringToFront();
    await page.waitForFunction(value => window.settingsWakeupFixture.unchanged > value && !window.settingsWakeupFixture.inFlight, polling, before.unchanged);
    assert.equal(await page.$eval('#httpsOnlyToggle', input => input.checked), !flag, 'Preferences must still refresh on return');
    assert.equal(await page.evaluate(() => window.settingsWakeupFixture.full), before.full, 'Preference changes must not transfer the lists');
    assert.equal(await page.evaluate(() => window.settingsWakeupFixture.mutations), before.mutations, 'Preference changes must not redraw the lists');
    // Keep a full response in flight while another view commits a newer rule.
    await page.evaluate(() => { window.settingsWakeupFixture.holdNextFull = true; window.settingsWakeupFixture.counts = []; });
    await other.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ action: 'SET_SINGLE_EXCEPTION', domain: 'wake-rules.test', isProxy: false }, resolve)));
    await page.waitForFunction(() => window.settingsWakeupFixture.releaseHeld, polling);
    const storageEvents = await page.evaluate(() => window.settingsWakeupFixture.storageEvents);
    await other.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ action: 'SET_SINGLE_EXCEPTION', domain: 'wake-rules.test', isProxy: true }, resolve)));
    await page.waitForFunction(value => window.settingsWakeupFixture.storageEvents > value, polling, storageEvents);
    await page.evaluate(() => {
      // Earlier refreshes may legitimately show the first edit. Only a redraw
      // after the newer storage event is known can be classified as stale.
      window.settingsWakeupFixture.counts = [];
      window.settingsWakeupFixture.releaseHeld();
    });
    await page.waitForFunction(() => !window.settingsWakeupFixture.inFlight && document.getElementById('includedCount').textContent === '33001', polling);
    assert.ok(!(await page.evaluate(() => window.settingsWakeupFixture.counts)).includes('33000'), 'A stale rules response must never redraw superseded lists');
    await other.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'hidden', polling);
    assert.equal((await other.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({
      action: 'SET_SINGLE_EXCEPTION', domain: 'wake-rules.test', isProxy: false,
    }, resolve)))).success, true);
    await page.bringToFront();
    await page.waitForFunction(value => window.settingsWakeupFixture.full > value && !window.settingsWakeupFixture.inFlight &&
      document.getElementById('includedCount').textContent === '33000' && document.getElementById('excludedCount').textContent === '2', polling, before.full);
    console.log('Chrome settings wake-up passed: 33001 rules, cached local saves/focus/preferences, no hidden refresh; actual rule edits restored on return.');
  } finally {
    await page.evaluate(() => {
      chrome.runtime.sendMessage = window.settingsWakeupFixture.original;
      window.settingsWakeupFixture.observer.disconnect();
      window.settingsWakeupFixture.counterObserver.disconnect();
      chrome.storage.onChanged.removeListener(window.settingsWakeupFixture.storageListener);
      delete window.settingsWakeupFixture;
    });
    await page.evaluate(value => new Promise(resolve => chrome.runtime.sendMessage({ action: 'SAVE_MODS', mods: { ifProxyHttpsUrlsOnly: value } }, resolve)), flag);
    await page.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ action: 'SET_SINGLE_EXCEPTION', domain: 'wake-rules.test', isProxy: null }, resolve)));
    if (other) await other.close();
  }
}
