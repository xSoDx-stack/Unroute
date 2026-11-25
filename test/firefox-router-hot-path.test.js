import assert from 'node:assert/strict';
import { TabProxyRouter } from '../src/common/core/tab-proxy-router.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';
import { utils } from '../src/common/core/utils.js';

const request = (url, type = 'image') => ({ tabId: 1, url, type });
const primary = { type: 'http', host: 'proxy.test', port: 8080 };

describe('Firefox router hot path', () => {
  let original, mods, router;
  beforeEach(() => {
    original = { chrome: globalThis.chrome, URL: globalThis.URL, getMods: pacKitchen.getPacMods,
      getCachedMods: pacKitchen.getCachedMods,
      getSettings: proxyBackend.getSettings, platform: proxyBackend.platform, getRootDomain: utils.getRootDomain,
      parseProxyScheme: utils.parseProxyScheme };
    mods = { ifMindExceptions: true, exceptions: { 'site.test': true },
      filteredCustomsString: 'PROXY proxy.test:8080' };
    pacKitchen.getPacMods = async () => mods;
    pacKitchen.getCachedMods = () => null;
    proxyBackend.getSettings = async () => ({ levelOfControl: 'controlled_by_this_extension', value: { proxyType: 'autoConfig' } });
    router = new TabProxyRouter();
  });
  afterEach(() => {
    globalThis.chrome = original.chrome;
    globalThis.URL = original.URL;
    pacKitchen.getPacMods = original.getMods;
    pacKitchen.getCachedMods = original.getCachedMods;
    proxyBackend.getSettings = original.getSettings;
    proxyBackend.platform = original.platform;
    utils.getRootDomain = original.getRootDomain;
    utils.parseProxyScheme = original.parseProxyScheme;
  });

  it('parses the destination only once even with an explicit tab route and a global constraint', async () => {
    const url = 'https://site.test/page';
    let parses = 0;
    globalThis.URL = class extends original.URL {
      constructor(input, ...args) {
        super(input, ...args);
        if (input === url) parses++;
      }
    };
    mods.ifMindWhitelist = true;
    mods.whitelist = ['site.test'];
    assert.deepEqual(await router.handle(request(url, 'main_frame')), [primary, null]);
    assert.equal(parses, 1);
  });

  it('skips the matcher for snapshots with no override rules, but keeps tracking navigation', async () => {
    let matches = 0;
    utils.getRootDomain = host => { matches++; return original.getRootDomain(host); };
    const active = mods;
    mods = { ...mods, exceptions: {}, domainLists: [{ enabled: false, domains: ['site.test'] }],
      pacBypassDomains: ['other.test'] };
    assert.equal(await router.handle(request('https://site.test/', 'main_frame')), undefined);
    assert.equal(await router.handle(request('https://cdn.test/')), undefined);
    assert.equal(matches, 0);

    mods = active;
    assert.deepEqual(await router.handle(request('https://cdn.test/')), [primary, null]);
  });

  it('does not skip resources explicitly excluded from inheritance without exception rules', async () => {
    mods = { ...mods, exceptions: {}, siteResourceInheritance: { 'site.test': false } };
    assert.equal(await router.handle(request('https://site.test/', 'main_frame')), undefined);
    assert.equal(await router.handle(request('https://cdn.test/')), null);
  });

  it('does not skip enabled list assignments without exceptions or a legacy proxy pool', async () => {
    mods = { ifMindExceptions: true, domainLists: [{ id: 'list', enabled: true, domains: ['site.test'],
      proxyId: 'custom:a' }], proxyRoutes: { 'custom:a': 'PROXY proxy.test:8080' } };
    assert.deepEqual(await router.handle(request('https://site.test/', 'main_frame')), [primary, null]);
  });

  it('skips cold tab IPC when cached mods cannot override PAC and resumes after a new snapshot', async () => {
    let tabReads = 0, modsReads = 0;
    const active = mods;
    pacKitchen.getCachedMods = () => mods;
    pacKitchen.getPacMods = async () => { modsReads++; return mods; };
    proxyBackend.platform = 'firefox';
    const event = { addListener() {} };
    globalThis.chrome = { runtime: {}, proxy: { onRequest: event, settings: { onChange: event } },
      tabs: { onRemoved: event, onUpdated: event, get: (_id, cb) => { tabReads++; cb({ url: 'https://site.test/' }); } } };
    router.setup();
    for (const inactive of [{ ...active, ifNoMods: true }, { ...active, ifMindExceptions: false },
      { ...active, exceptions: {} }]) {
      mods = inactive;
      assert.equal(await router.handle(request('https://cdn.test/')), undefined);
    }
    assert.deepEqual([tabReads, modsReads], [0, 0]);
    mods.exceptions['site.test'] = true;
    assert.deepEqual(await router.handle(request('https://cdn.test/')), [primary, null]);
    mods = active;
    assert.deepEqual(await router.handle(request('https://cdn.test/')), [primary, null]);
    assert.equal(tabReads, 1);
  });

  it('starts cold mods and tab lookups together', async () => {
    let receiveTab;
    let reads = 0;
    globalThis.chrome = { runtime: {}, tabs: { get: (_id, cb) => { receiveTab = cb; } } };
    pacKitchen.getPacMods = async () => { reads++; return mods; };
    const result = router.handle(request('https://cdn.test/'));
    await Promise.resolve();
    assert.equal(typeof receiveTab, 'function');
    assert.equal(reads, 1);
    receiveTab({ url: 'https://site.test/' });
    assert.deepEqual(await result, [primary, null]);
  });

  it('does not apply a new tab host to an older request while loading mods', async () => {
    let resolveMods;
    pacKitchen.getPacMods = () => new Promise(resolve => { resolveMods = resolve; });
    router.tabs.set(1, 'old.test');
    const result = router.handle(request('https://cdn.test/'));
    router.tabs.set(1, 'site.test');
    resolveMods(mods);
    assert.equal(await result, undefined);
  });

  it('reuses parsed endpoints without sharing returned nodes or caching the strictness flag', async () => {
    let parses = 0;
    utils.parseProxyScheme = (...args) => { parses++; return original.parseProxyScheme(...args); };
    mods.domainProxyIds = { 'site.test': 'custom:a' };
    mods.proxyRoutes = { 'custom:a': mods.filteredCustomsString };
    const req = request('https://site.test/', 'main_frame');
    const chain = await router.handle(req);
    chain[0].host = 'changed.test';
    chain.pop();
    mods = { ...mods, ownProxyOrDie: false };
    assert.deepEqual(await router.handle(req), [primary, { type: 'direct' }, null]);
    assert.equal(parses, 1);

    mods = { ...mods, fallbackProxyChain: 'SOCKS5 reserve.test:1080' };
    assert.deepEqual(await router.handle(req), [primary,
      { type: 'socks', host: 'reserve.test', port: 1080, proxyDNS: true }, { type: 'direct' }, null]);
    mods = { ...mods, proxyRoutes: { 'custom:a': 'HTTPS new.test:443' }, fallbackProxyChain: '' };
    assert.deepEqual(await router.handle(req), [{ type: 'https', host: 'new.test', port: 443 }, { type: 'direct' }, null]);
  });

  it('evicts old endpoints after 64 distinct chains', async () => {
    let parses = 0;
    utils.parseProxyScheme = (...args) => { parses++; return original.parseProxyScheme(...args); };
    const req = request('https://site.test/', 'main_frame');
    for (let i = 0; i <= 64; i++) {
      mods = { ...mods, filteredCustomsString: `PROXY proxy${i}.test:8080` };
      await router.handle(req);
    }
    await router.handle(req);
    assert.equal(parses, 65);
    mods = { ...mods, filteredCustomsString: 'PROXY proxy0.test:8080' };
    await router.handle(req);
    assert.equal(parses, 66);
  });

  it('registers only supported web schemes, including both WebSocket handshakes', async () => {
    let listener, urls;
    let settingsReads = 0;
    const getSettings = proxyBackend.getSettings;
    proxyBackend.getSettings = () => { settingsReads++; return getSettings(); };
    proxyBackend.platform = 'firefox';
    const event = { addListener() {} };
    globalThis.chrome = {
      proxy: { onRequest: { addListener(fn, filter) { listener = fn; urls = filter.urls; } }, settings: { onChange: event } },
      tabs: { onRemoved: event, onUpdated: event },
    };
    router.setup();
    assert.deepEqual(urls, ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']);
    assert.equal(settingsReads, 0);
    await listener(request('https://site.test/', 'main_frame'));
    for (const protocol of ['ws', 'wss']) {
      assert.deepEqual(await listener(request(`${protocol}://cdn.test/socket`, 'websocket')), [primary, null]);
    }
    assert.equal(settingsReads, 1);
  });
});
