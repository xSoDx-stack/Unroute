// Test-only RPC adapter: legacy fixture replacements participate in the same
// optimistic concurrency contract as the production raw editor. Explicit stale
// revisions remain untouched so conflict assertions still exercise the backend.
export async function sendFirefoxFixtureMessage(message) {
  const request = payload => new Promise(resolve => chrome.runtime.sendMessage(payload, resolve));
  if (message.action === 'SAVE_MODS' && message.expectedRevision === undefined &&
      ['exceptions', 'whitelist'].some(key => Object.hasOwn(message.mods || {}, key))) {
    const snapshot = await request({ action: 'GET_EXCEPTIONS' });
    if (!snapshot.success) throw new Error('Fixture revision lookup failed: ' + JSON.stringify(snapshot));
    message = { ...message, expectedRevision: snapshot.data.revision };
  }
  return request(message);
}

// Executed inside the real temporary Firefox extension, against two local HTTP
// servers. No routing, catalog, settings or browser APIs are mocked.
export async function checkFirefoxMultiProxy({ port, proxyPort, secondProxyPort, report }) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const send = sendFirefoxFixtureMessage;
  const call = async message => {
    const response = await send(message);
    assert(response.success, message.action + ': ' + JSON.stringify(response));
    return response.data;
  };
  const snapshot = () => call({ action: 'GET_EXCEPTIONS' });
  const prefs = { customProxyStringRaw: `HTTP 127.0.0.1:${proxyPort}\nHTTP 127.0.0.1:${secondProxyPort}`,
    ifUseSecureProxiesOnly: false, ifMindExceptions: true, ifMindWhitelist: false,
    ifProxyHttpsUrlsOnly: false, ifUseLocalTor: false, ifUseLocalWarp: false };
  await call({ action: 'SAVE_MODS', mods: prefs });
  let state = await snapshot();
  const a = state.proxyCatalog.find(profile => profile.endpoint === `PROXY 127.0.0.1:${proxyPort}`);
  const b = state.proxyCatalog.find(profile => profile.endpoint === `PROXY 127.0.0.1:${secondProxyPort}`);
  assert(a && b && a.id !== b.id, 'Two distinct custom profiles must exist');
  assert(state.defaultProxyId === a.id, 'Adding B must not replace the first default A');
  assert(!state.domainProxyIds['proxy.test'], 'Legacy positive fixture must remain unassigned');
  for (const [id, name] of [['builtin:tor', 'Tor'], ['builtin:warp', 'Cloudflare WARP']]) {
    assert(state.proxyCatalog.some(profile => profile.id === id && profile.name === name && profile.builtin), 'Fixed built-in catalog: ' + id);
  }
  const nativeBefore = await browser.proxy.settings.get({});
  await call({ action: 'RENAME_PROXY_PROFILE', proxyId: a.id, name: 'Local Firefox A' });
  const renamed = await snapshot();
  assert(renamed.revision === state.revision && renamed.catalogRevision !== state.catalogRevision,
    'Rename must change only catalog revision');
  assert(JSON.stringify(await browser.proxy.settings.get({})) === JSON.stringify(nativeBefore), 'Rename must not apply PAC');
  assert(renamed.proxyCatalog.some(profile => profile.id === a.id && profile.name === 'Local Firefox A'), 'Rename must preserve ID');
  const unchanged = await call({ action: 'GET_EXCEPTIONS', knownRevision: state.revision });
  assert(unchanged.unchanged && unchanged.proxyCatalog.some(profile => profile.id === a.id && profile.name === 'Local Firefox A'),
    'Unchanged rule response must still carry the refreshed catalog');
  await call({ action: 'SET_DEFAULT_PROXY', proxyId: b.id });
  const changedDefault = await snapshot();
  assert(changedDefault.defaultProxyId === b.id && changedDefault.revision === state.revision,
    'Default selection must not change routing revision');
  assert(JSON.stringify(await browser.proxy.settings.get({})) === JSON.stringify(nativeBefore), 'Default selection must not apply PAC');
  await call({ action: 'SET_DEFAULT_PROXY', proxyId: a.id });
  const large = Object.fromEntries(Array.from({ length: 33000 }, (_, i) => [`large-firefox-${i}.test`, true]));
  await call({ action: 'SAVE_MODS', proxyId: a.id, mods: { exceptions: { ...state.exceptions, ...large } } });
  const largeSnapshot = await snapshot();
  assert(Object.keys(largeSnapshot.exceptions).length === Object.keys(state.exceptions).length + 33000,
    'Large Firefox snapshot must retain all 33000 additional rules');
  assert(largeSnapshot.domainProxyIds['large-firefox-32999.test'] === a.id && !largeSnapshot.domainProxyIds['proxy.test'],
    'Large new rules must be pinned without migrating legacy rules');
  await call({ action: 'SAVE_MODS', mods: { exceptions: state.exceptions } });
  await report({ stage: 'multiproxy-large-rules', added: 33000, restored: true });
  await call({ action: 'MUTATE_DOMAIN_RULES', operations: [
    { domain: 'route-a.test', mode: 'proxy', proxyId: a.id },
    { domain: 'route-b.test', mode: 'proxy', proxyId: b.id },
  ] });
  const pinned = await snapshot();
  assert(pinned.domainProxyIds['route-a.test'] === a.id && pinned.domainProxyIds['route-b.test'] === b.id,
    'New RPC rules must be pinned in the separate assignment map');
  const tabs = [];
  const open = async host => {
    const tab = await browser.tabs.create({ url: `http://${host}:${port}/multiproxy-main` });
    tabs.push(tab);
    for (let i = 0; i < 100; i++) {
      const current = await browser.tabs.get(tab.id);
      if (current.status === 'complete' && current.url === `http://${host}:${port}/multiproxy-main`) return tab;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Multi-proxy tab timeout: ' + host);
  };
  let sequence = 0;
  const probe = async (tab, host, label, expected) => {
    const url = `http://${host}:${port}/multiproxy-${label}-${++sequence}`;
    const actual = (await browser.scripting.executeScript({ target: { tabId: tab.id },
      func: async url => (await fetch(url, { cache: 'no-store' })).text(), args: [url] }))[0].result;
    assert(actual === expected, `${label}: expected ${expected}, received ${actual}`);
    await report({ stage: 'multiproxy-route', label, url, actual });
  };
  try {
    const tabA = await open('route-a.test');
    const tabB = await open('route-b.test');
    await probe(tabA, 'route-a.test', 'A-to-A', 'own-proxy');
    await probe(tabB, 'route-b.test', 'B-to-B', 'second-proxy');
    await probe(tabA, 'shared-cdn.test', 'shared-from-A', 'own-proxy');
    await probe(tabB, 'shared-cdn.test', 'shared-from-B', 'second-proxy');
    await probe(tabA, 'route-b.test', 'explicit-B-over-tab-A', 'second-proxy');
    await probe(tabB, 'route-a.test', 'explicit-A-over-tab-B', 'own-proxy');
    await call({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'shared-cdn.test', mode: 'proxy', proxyId: b.id }] });
    await probe(tabA, 'shared-cdn.test', 'manual-CDN-B-over-tab-A', 'second-proxy');
    state = await snapshot();
    await call({ action: 'ASSIGN_DOMAIN_PROXIES', domains: ['shared-cdn.test'], proxyId: a.id, expectedRevision: state.revision });
    await probe(tabB, 'shared-cdn.test', 'moved-CDN-A-over-tab-B', 'own-proxy');
    const stale = await send({ action: 'SAVE_MODS', mods: { exceptions: {} }, expectedRevision: state.revision });
    assert(!stale.success, 'Explicit stale replacement revision must not be repaired by fixture helper');
    assert((await snapshot()).domainProxyIds['shared-cdn.test'] === a.id, 'Rejected stale write changed assignment');
    await call({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'shared-cdn.test', mode: 'direct' }] });
    await probe(tabA, 'shared-cdn.test', 'manual-direct-over-tab-A', 'origin-direct');
    await probe(tabB, 'shared-cdn.test', 'manual-direct-over-tab-B', 'origin-direct');
  } finally {
    await Promise.all(tabs.map(tab => browser.tabs.remove(tab.id)));
    await call({ action: 'MUTATE_DOMAIN_RULES', operations: ['route-a.test', 'route-b.test', 'shared-cdn.test'].map(domain => ({ domain, mode: 'pac' })) });
    await call({ action: 'SAVE_MODS', mods: { customProxyStringRaw: '' } });
  }
  return { a: a.id, b: b.id, probes: sequence };
}
