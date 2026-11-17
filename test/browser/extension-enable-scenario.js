import assert from 'node:assert/strict';
import fs from 'node:fs';

function storedRuleFixture() {
  const { path, extensionId } = JSON.parse(process.env.UNROUTE_ENABLE_RULES_PROFILE);
  const settings = JSON.parse(fs.readFileSync(path, 'utf8'));
  const url = settings.extensions.settings[extensionId].preferences.proxy.pac_url;
  const separator = url.indexOf(',');
  const source = url.slice(0, separator).includes(';base64')
    ? Buffer.from(url.slice(separator + 1), 'base64').toString('utf8')
    : decodeURIComponent(url.slice(separator + 1));
  const table = name => {
    const marker = `const ${name} = `;
    const start = source.indexOf(marker);
    assert.ok(start >= 0, 'Stored routing table is missing');
    return JSON.parse(source.slice(start + marker.length, source.indexOf(';\n', start)));
  };
  return Object.fromEntries([
    ...Object.entries(table('excExact')).map(([domain, value]) => [domain, value === 1]),
    ...Object.entries(table('excWild')).map(([domain, value]) => [`*.${domain}`, value === 1]),
  ]);
}

// Exercise Chrome's extension enable switch, including restoration of its
// persisted profile-wide PAC before a new service worker is ready.
export async function verifyExtensionEnable(browser, initial, proxy, originPort, credentials) {
  let worker = initial.worker;
  let options = initial.options;
  const extensionId = initial.extensionId;
  console.log('Opening extension enable observers...');
  const observer = await browser.newPage();
  await observer.goto(`http://127.0.0.2:${originPort}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await observer.evaluate(() => {
    window.enableGaps = [];
    let previous = performance.now();
    window.enableTimer = setInterval(() => {
      const now = performance.now();
      window.enableGaps.push(now - previous);
      previous = now;
    }, 10);
  });
  const controls = await browser.newPage();
  await controls.goto('chrome://extensions/');
  await controls.waitForSelector('pierce/extensions-item');
  const toggle = async enabled => {
    await controls.bringToFront();
    const handle = await controls.evaluateHandle(id => document.querySelector('extensions-manager').shadowRoot
      .querySelector('extensions-item-list').shadowRoot.querySelector(`extensions-item[id="${id}"]`)
      .shadowRoot.querySelector('#enableToggle'), extensionId);
    assert.ok(handle.asElement(), 'Extension enable toggle is missing');
    const started = Date.now();
    await handle.asElement().evaluate(element => element.click());
    await handle.dispose();
    await controls.waitForFunction((id, value) => document.querySelector('extensions-manager').shadowRoot
      .querySelector('extensions-item-list').shadowRoot.querySelector(`extensions-item[id="${id}"]`)
      .shadowRoot.querySelector('#enableToggle').checked === value, { timeout: 20000 }, extensionId, enabled);
    return Date.now() - started;
  };
  const send = message => options.evaluate(payload => new Promise(resolve => chrome.runtime.sendMessage(payload, resolve)), message);
  try {
    if (process.env.UNROUTE_ENABLE_STORAGE_PROFILE) {
      const migrated = await worker.evaluate(async () => {
        const { pacKitchen, storage } = globalThis.__proxyTestHooks;
        const before = await pacKitchen.getRawPacMods();
        await pacKitchen.updatePacMods(current => current, { copyOnWrite: true });
        const stored = await storage.get('pac-kitchen-mods');
        return { schema: stored._schemaVersion, packed: typeof stored._ruleData === 'string',
          preservedRevision: stored._revision === before._revision };
      });
      assert.deepEqual(migrated, { schema: 2, packed: true, preservedRevision: true },
        'Legacy storage must upgrade automatically before any user edit');
    }
    const fixtures = process.env.UNROUTE_ENABLE_STORAGE_PROFILE ? [null] : [{}, process.env.UNROUTE_ENABLE_RULES_PROFILE ? storedRuleFixture() :
      Object.fromEntries(Array.from({ length: 33000 }, (_, index) => [`domain-${index}.example.com`, true]))];
    for (let phase = 0; phase < fixtures.length; phase++) {
      const exceptions = fixtures[phase];
      const count = exceptions ? Object.keys(exceptions).length : Object.keys((await send({ action: 'GET_EXCEPTIONS' })).data.exceptions).length;
      console.log(`Saving ${count} rules before enable test...`);
      const saved = exceptions ? await send({ action: 'SAVE_MODS', mods: { exceptions,
        customProxyStringRaw: `HTTP ${credentials.username}:${credentials.password}@127.0.0.1:${proxy.port}`,
        ifUsePacScriptProxies: false, ifUseSecureProxiesOnly: false } }) : { success: true };
      assert.equal(saved.success, true);
      const samples = process.env.UNROUTE_ENABLE_STORAGE_PROFILE ? 1 : 3;
      for (let sample = 0; sample < samples; sample++) {
        console.log(`Disabling extension: ${count} rules, sample ${sample}...`);
        const workerUrl = `chrome-extension://${extensionId}/service-worker.js`;
        const previousTarget = browser.targets().find(target => target.type() === 'service_worker' && target.url() === workerUrl);
        assert.ok(previousTarget, 'Previous extension worker is missing');
        let stopped;
        const destroyed = new Promise(resolve => { stopped = target => { if (target === previousTarget) resolve(); }; });
        browser.on('targetdestroyed', stopped);
        let timeout;
        try {
          await worker.client.detach();
          await toggle(false);
          await Promise.race([destroyed, new Promise((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Extension worker did not stop after disabling')), 20000);
          })]);
        } finally { clearTimeout(timeout); browser.off('targetdestroyed', stopped); }
        await observer.evaluate(() => { window.enableGaps = []; });
        const started = Date.now();
        console.log('Enabling extension through Chrome settings...');
        const toggleMs = await toggle(true);
        const target = await browser.waitForTarget(candidate => candidate.type() === 'service_worker' &&
          candidate !== previousTarget && candidate.url() === workerUrl, { timeout: 20000 });
        assert.notEqual(target, previousTarget, 'Enabling must start a new extension worker');
        worker = await target.worker();
        const startup = await worker.evaluate(async () => {
          await globalThis.__proxyTestHooks.appState.ensureInitialized();
          const raw = await globalThis.__proxyTestHooks.pacKitchen.getRawPacMods();
          return { timings: globalThis.enableTimings || [], stored: globalThis.enableStoredSnapshot, schema: raw._schemaVersion,
            metadata: Object.keys(raw.ruleMeta).length,
            historyChanges: raw.ruleHistory.reduce((sum, item) => sum + item.changes.length, 0) };
        });
        const readyMs = Date.now() - started;
        options = await browser.newPage();
        await options.goto(`chrome-extension://${extensionId}/pages/options/index.html#pac`);
        const restored = await send({ action: 'GET_EXCEPTIONS' });
        assert.equal(Object.keys(restored.data.exceptions).length, count);
        const maxRendererGapMs = await observer.evaluate(() => Math.max(0, ...window.enableGaps));
        console.log('Chrome extension enable:', JSON.stringify({ phase, rules: count, sample,
          toggleMs: Math.round(toggleMs), readyMs, maxRendererGapMs: Math.round(maxRendererGapMs), ...startup }));
      }
    }
  } catch (error) {
    console.error('Extension enable scenario failed:', error);
    throw error;
  } finally {
    await observer.close().catch(() => {});
    await controls.close().catch(() => {});
    await options.close().catch(() => {});
  }
}
