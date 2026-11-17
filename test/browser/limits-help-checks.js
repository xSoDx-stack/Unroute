// Runs inside the installed extension's options document on Chrome and Firefox.
// Browser RPC, storage and controls are real; no response or validator is mocked.
export async function checkLimitsAndHelp() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const request = message => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${message.action}`)), 20000);
    chrome.runtime.sendMessage(message, response => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
  const send = async message => {
    // Fixture setup only; production controls supply their own captured revision.
    if (message.action === 'SAVE_MODS' && message.expectedRevision === undefined &&
        ['exceptions', 'whitelist'].some(key => Object.hasOwn(message.mods || {}, key))) {
      const snapshot = await request({ action: 'GET_EXCEPTIONS' });
      assert(snapshot?.success, 'Fixture revision lookup failed');
      message = { ...message, expectedRevision: snapshot.data.revision };
    }
    return request(message);
  };
  const ok = async message => {
    const response = await send(message);
    assert(response?.success, `${message.action}: ${response?.error}`);
    return response.data;
  };
  const wait = async predicate => {
    const end = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > end) throw new Error('Proxy limits/help UI timeout');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await wait(() => document.getElementById('extVersion')?.textContent.trim());
  const previous = (await ok({ action: 'GET_STATE', includeExceptions: true })).pacMods;
  const raw = count => Array.from({ length: count }, (_, i) => `HTTP limit-${i}.invalid:8080`).join('; ');
  let checked = 0;
  try {
    await ok({ action: 'SAVE_MODS', mods: { exceptions: {}, whitelist: [], customProxyStringRaw: '',
      ifUseSecureProxiesOnly: true, ifUseLocalTor: false, ifUseLocalWarp: false,
      ifUseOwnProxiesOnlyForOwnSites: true } });
    await ok({ action: 'SAVE_MODS', mods: { customProxyStringRaw: raw(50) } });
    let saved = await ok({ action: 'GET_EXCEPTIONS' });
    assert(saved.proxyCatalog.filter(profile => !profile.builtin).length === 50, '50 custom profiles must be accepted');
    assert(saved.proxyCatalog.filter(profile => !profile.builtin).every(profile => !profile.enabled), 'Disabled custom profiles must still count');
    const unchanged = JSON.stringify(saved);
    const rejected = await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: raw(51) } });
    assert(rejected?.success === false && /50/.test(rejected.error), '51st proxy must be rejected with a clear limit message');
    assert(JSON.stringify(await ok({ action: 'GET_EXCEPTIONS' })) === unchanged, 'Rejected save changed rules/catalog/history/revisions');
    await ok({ action: 'SAVE_MODS', mods: { ifUseLocalTor: true, ifUseLocalWarp: true } });
    saved = await ok({ action: 'GET_EXCEPTIONS' });
    assert(saved.proxyCatalog.length === 52, 'Tor/WARP must be outside the custom limit');
    await ok({ action: 'SAVE_MODS', mods: { customProxyStringRaw: raw(49) } });
    await ok({ action: 'SAVE_MODS', mods: { customProxyStringRaw: raw(50) } });
    // Trigger the ordinary background/storage refresh and verify generated cards
    // as well as every static settings section without a test-only render path.
    document.querySelector('[data-tab="proxies"]').click();
    await wait(() => document.querySelectorAll('.proxy-profile-name').length === 50).catch(error => {
      error.message += `; profileNames=${document.querySelectorAll('.proxy-profile-name').length}; cards=${document.querySelectorAll('#proxyCardsList .proxy-item').length}; rawLines=${document.getElementById('customProxyText').value.split(/;|\n/).length}; load=${document.getElementById('applicationBanner')?.textContent}`;
      throw error;
    });
    for (const tab of document.querySelectorAll('.nav-tab-btn[data-tab]')) {
      tab.click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const section = document.getElementById(`tab-${tab.dataset.tab}`);
      const controls = [tab, ...section.querySelectorAll('button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"]')];
      for (const control of controls) {
        const style = getComputedStyle(control);
        if (!control.getClientRects().length || style.visibility === 'hidden' || style.display === 'none') continue;
        const help = control.getAttribute('title') || control.closest('label[title]')?.getAttribute('title');
        assert(help?.trim(), `Missing native hover help: ${tab.dataset.tab}/${control.id || control.className || control.tagName}`);
        assert(!/limit-\d+\.invalid/.test(help), 'Help must not disclose proxy endpoint values');
        checked++;
      }
    }
    assert(checked > 50, 'Help coverage did not exercise the real settings controls');
    return `50 custom accepted (including disabled), 51 rejected atomically, 2 built-ins excluded; ${checked} visible controls have hover help across settings tabs`;
  } finally {
    await ok({ action: 'SAVE_MODS', mods: { exceptions: {}, whitelist: [] } });
    const restore = Object.fromEntries(Object.entries(previous).filter(([key]) => ![
      'proxyProfiles', 'proxyCatalog', 'domainProxyIds', 'defaultProxyId', 'proxyCatalogRevision',
      'rulesRevision', 'exceptionStats', 'exceptions', 'whitelist', 'ruleMeta', 'ruleHistory',
    ].includes(key)));
    await ok({ action: 'SAVE_MODS', mods: restore });
    // Enabling built-ins may have selected Tor while all HTTP profiles were
    // disabled. Disabling Tor deliberately preserves that default in production;
    // restore the fixture's intended default explicitly instead of leaking it.
    const catalog = (await ok({ action: 'GET_EXCEPTIONS' })).proxyCatalog;
    const previousDefault = previous.proxyCatalog?.find(profile => profile.id === previous.defaultProxyId);
    const target = catalog.find(profile => profile.enabled && profile.endpoint === previousDefault?.endpoint) ||
      catalog.find(profile => profile.enabled);
    await ok({ action: 'SET_DEFAULT_PROXY', proxyId: target?.id ?? null });
    await ok({ action: 'SAVE_MODS', mods: { exceptions: previous.exceptions, whitelist: previous.whitelist } });
  }
}
