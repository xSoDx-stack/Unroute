'use strict';

import { expect } from 'chai';
import { TabProxyRouter, ownProxyChain } from '../src/common/core/tab-proxy-router.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';

describe('Firefox own-proxy tab routing', () => {
  let original;
  let mods;
  let router;
  let settings;
  let reads;
  beforeEach(() => {
    original = { chrome: globalThis.chrome, mods: pacKitchen.getPacMods, settings: proxyBackend.getSettings };
    mods = { ifMindExceptions: true, filteredCustomsString: 'PROXY localhost:8080',
      exceptions: { 'proxy.test': true, 'direct.test': false, 'cdn.test': true },
      ruleMeta: { 'exception:cdn.test': { source: 'auto', site: 'proxy.test' } } };
    settings = { levelOfControl: 'controlled_by_this_extension', value: { proxyType: 'autoConfig' } };
    reads = 0;
    pacKitchen.getPacMods = async () => mods;
    proxyBackend.getSettings = async () => { reads++; return settings; };
    globalThis.chrome = { runtime: {}, tabs: { get: (id, cb) => cb({ url: 'https://direct.test/' }) } };
    router = new TabProxyRouter();
  });
  afterEach(() => {
    globalThis.chrome = original.chrome;
    pacKitchen.getPacMods = original.mods;
    proxyBackend.getSettings = original.settings;
  });
  const req = (tabId, url, type = 'image') => ({ tabId, url, type });

  it('never appends a DIRECT fallback to an unassigned tab route unless ownProxyOrDie is explicitly disabled', async () => {
    mods.ifProxyOrDie = true;
    const chain = await router.handle(req(1, 'https://proxy.test/', 'main_frame'));
    expect(chain).to.deep.equal([{ type: 'http', host: 'localhost', port: 8080 }, null]);
    mods.ifProxyOrDie = false;
    expect(await router.handle(req(1, 'https://cdn.test/'))).to.deep.equal([chain[0], null]);
    mods.ownProxyOrDie = false;
    expect(await router.handle(req(1, 'https://cdn.test/'))).to.deep.equal([chain[0], { type: 'direct' }, null]);
  });

  it('routes the same CDN differently in two tabs without modifying rules', async () => {
    const saved = JSON.stringify(mods);
    await router.handle(req(1, 'https://proxy.test/', 'main_frame'));
    await router.handle(req(2, 'https://direct.test/', 'main_frame'));
    expect(await router.handle(req(1, 'https://cdn.test/video'))).to.deep.equal([
      { type: 'http', host: 'localhost', port: 8080 }, null,
    ]);
    expect(await router.handle(req(2, 'https://cdn.test/video'))).to.equal(null);
    expect(reads).to.equal(1);
    expect(JSON.stringify(mods)).to.equal(saved);
  });
  it('replaces implicit DIRECT on unassigned routes and refreshes the chain when it changes', async () => {
    mods.ownProxyOrDie = false;
    mods.fallbackProxyChain = 'HTTPS reserve.test:443';
    mods.replaceDirectWith = 'HTTPS replace.test:443; DIRECT';
    const route = () => router.handle(req(1, 'https://proxy.test/', 'main_frame'));
    const prefix = [{ type: 'http', host: 'localhost', port: 8080 }, { type: 'https', host: 'reserve.test', port: 443 }];
    expect(await route()).to.deep.equal([...prefix, { type: 'https', host: 'replace.test', port: 443 }, { type: 'direct' }, null]);
    mods.replaceDirectWith = 'HTTPS next.test:443';
    expect(await route()).to.deep.equal([...prefix, { type: 'https', host: 'next.test', port: 443 }, null]);
    mods.ownProxyOrDie = true;
    expect(await route()).to.deep.equal([...prefix, null]);
    expect(await router.handle(req(1, 'https://direct.test/', 'main_frame'))).to.equal(null);
  });

  it('fails closed only for eligible strict unassigned routes when settings are unavailable', async () => {
    proxyBackend.getSettings = async () => { throw new Error('Settings unavailable'); };
    mods.ownProxyOrDie = true;
    const route = url => router.handle(req(1, url, 'main_frame'));
    expect(await route('https://proxy.test/')).to.deep.equal([{ type: 'http', host: '127.0.0.1', port: 9 }]);
    mods.ifProxyHttpsUrlsOnly = true;
    expect(await route('http://proxy.test/')).to.equal(undefined);
    expect(await route('https://direct.test/')).to.equal(undefined);
    mods.ownProxyOrDie = false;
    expect(await route('https://proxy.test/')).to.equal(undefined);
    proxyBackend.getSettings = async () => settings;
    expect(await route('https://proxy.test/')).to.deep.equal([
      { type: 'http', host: 'localhost', port: 8080 }, { type: 'direct' }, null,
    ]);
  });

  it('does not override standard PAC, disabled mods, or another extension', async () => {
    await router.handle(req(1, 'https://proxy.test/', 'main_frame'));
    mods.filteredCustomsString = '';
    expect(await router.handle(req(1, 'https://cdn.test/'))).to.equal(undefined);
    mods.filteredCustomsString = 'SOCKS5 localhost:9050';
    mods.ifNoMods = true;
    expect(await router.handle(req(1, 'https://cdn.test/'))).to.equal(undefined);
    mods.ifNoMods = false;
    mods.ifMindExceptions = false;
    expect(await router.handle(req(1, 'https://cdn.test/'))).to.equal(undefined);
    mods.ifMindExceptions = true;
    settings.levelOfControl = 'controlled_by_other_extensions';
    expect(await router.handle(req(1, 'https://cdn.test/'))).to.equal(undefined);
    settings.levelOfControl = 'controlled_by_this_extension';
    settings.value.proxyType = 'system';
    expect(await router.handle(req(1, 'https://cdn.test/'))).to.equal(undefined);
  });
  it('uses new main-frame destinations and changed rules immediately', async () => {
    await router.handle(req(1, 'https://proxy.test/', 'main_frame'));
    expect(await router.handle(req(1, 'https://direct.test/', 'main_frame'))).to.equal(null);
    expect(await router.handle(req(1, 'https://cdn.test/frame', 'sub_frame'))).to.equal(null);
    mods.exceptions['direct.test'] = true;
    expect(await router.handle(req(1, 'https://cdn.test/'))).to.be.an('array');
    delete mods.exceptions['direct.test'];
    expect(await router.handle(req(1, 'https://cdn.test/'))).to.equal(undefined);
  });
  it('restores existing tabs and handles private tabs only in memory', async () => {
    expect(await router.handle({ ...req(4, 'https://cdn.test/'), incognito: true })).to.equal(null);
    expect(router.tabs.get(4)).to.equal('direct.test');
  });
  it('starts empty after a worker restart and removes closed-tab cache entries', () => {
    const platform = proxyBackend.platform;
    const removed = [], updated = [], requested = [], changed = [];
    try {
      proxyBackend.platform = 'firefox';
      chrome.proxy = { onRequest: { addListener: listener => requested.push(listener) },
        settings: { onChange: { addListener: listener => changed.push(listener) } } };
      chrome.tabs.onRemoved = { addListener: listener => removed.push(listener) };
      chrome.tabs.onUpdated = { addListener: listener => updated.push(listener) };
      router.setup(); router.setup();
      expect([requested.length, changed.length, removed.length, updated.length]).to.deep.equal([1, 1, 1, 1]);
      for (let id = 1; id <= 48; id++) updated[0](id, { url: `https://tab${id}.test/` });
      expect(router.tabs.size).to.equal(48);
      for (let id = 1; id <= 48; id++) removed[0](id);
      expect(router.tabs.size).to.equal(0);
      router.tabs.set(49, 'previous-worker.test');
      expect(new TabProxyRouter().tabs.size).to.equal(0);
    } finally { proxyBackend.platform = platform; }
  });
  it('does not resurrect a closed tab when its pending lookup finishes late', async () => {
    const platform = proxyBackend.platform;
    let close, finishLookup;
    try {
      proxyBackend.platform = 'firefox';
      chrome.proxy = { onRequest: { addListener: () => {} }, settings: { onChange: { addListener: () => {} } } };
      chrome.tabs.onRemoved = { addListener: listener => { close = listener; } };
      chrome.tabs.onUpdated = { addListener: () => {} };
      chrome.tabs.get = (_id, callback) => { finishLookup = callback; };
      router.setup();
      const pending = router.handle(req(50, 'https://cdn.test/'));
      expect(router.tabs.has(50)).to.equal(true);
      close(50);
      finishLookup({ url: 'https://proxy.test/' });
      expect(await pending).to.equal(undefined);
      expect(router.tabs.has(50)).to.equal(false);
    } finally { proxyBackend.platform = platform; }
  });
  it('leaves unassociated and speculative traffic unchanged', async () => {
    expect(await router.handle(req(-1, 'https://proxy.test/'))).to.equal(undefined);
    expect(await router.handle(req(1, 'https://proxy.test/', 'speculative'))).to.equal(undefined);
    expect(await router.handle(req(1, 'file:///local'))).to.equal(undefined);
    expect(reads).to.equal(0);
  });
  it('converts only configured endpoints, preserving order and SOCKS DNS', () => {
    expect(ownProxyChain({ filteredCustomsString: 'HTTPS proxy.test:443; SOCKS5 [::1]:9050; SOCKS localhost:1080' }))
      .to.deep.equal([{ type: 'https', host: 'proxy.test', port: 443 },
        { type: 'socks', host: '::1', port: 9050, proxyDNS: true },
        { type: 'socks4', host: 'localhost', port: 1080, proxyDNS: true }]);
  });

  it('applies HTTPS-only to HTTP and WebSocket resources before the tab proxy rule', async () => {
    mods.ifProxyHttpsUrlsOnly = true;
    await router.handle(req(1, 'https://proxy.test/', 'main_frame'));
    for (const url of ['http://cdn.test/image', 'ws://cdn.test/socket', 'wss://cdn.test/socket']) {
      expect(await router.handle(req(1, url))).to.equal(null);
    }
    expect(await router.handle(req(1, 'https://cdn.test/image'))).to.be.an('array');
    settings.levelOfControl = 'controlled_by_other_extensions';
    expect(await router.handle(req(1, 'http://cdn.test/image'))).to.equal(undefined);
  });

  it('restricts tab resources to the enabled whitelist, including wildcard descendants', async () => {
    mods.ifMindWhitelist = true;
    mods.whitelist = ['proxy.test', '*.allowed.cdn.test'];
    await router.handle(req(1, 'https://proxy.test/', 'main_frame'));
    expect(await router.handle(req(1, 'https://cdn.test/image'))).to.equal(null);
    expect(await router.handle(req(1, 'https://image.allowed.cdn.test/image'))).to.be.an('array');
    expect(await router.handle(req(1, 'https://allowed.cdn.test/image'))).to.be.an('array');
    expect(await router.handle(req(1, 'https://notallowed.cdn.test/image'))).to.equal(null);
    mods.whitelist = [];
    expect(await router.handle(req(1, 'https://image.allowed.cdn.test/image'))).to.equal(null);
    mods.ifMindWhitelist = false;
    expect(await router.handle(req(1, 'https://cdn.test/image'))).to.be.an('array');
  });
});
