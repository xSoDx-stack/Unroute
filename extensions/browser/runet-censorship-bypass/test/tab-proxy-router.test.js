'use strict';

import { expect } from 'chai';
import { TabProxyRouter, ownProxyChain } from '../src/extension-common/core/tab-proxy-router.js';
import { pacKitchen } from '../src/extension-common/core/pac-kitchen.js';
import { proxyBackend } from '../src/extension-common/core/proxy-backend.js';

describe('Firefox own-proxy tab routing', () => {
  let original;
  let mods;
  let router;
  let settings;
  let reads;
  beforeEach(() => {
    original = { chrome: globalThis.chrome, mods: pacKitchen.getPacMods, settings: proxyBackend.getSettings };
    mods = { ifMindExceptions: true, filteredCustomsString: 'PROXY localhost:8080',
      exceptions: { 'proxy.test': true, 'direct.test': false, 'cdn.test': true } };
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
});
