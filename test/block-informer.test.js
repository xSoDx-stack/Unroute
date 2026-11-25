'use strict';

import { expect } from 'chai';
import { ipToHost } from '../src/common/core/ip-to-host.js';
import {
  blockInformer,
  classifyProxySource,
  normalizeProxyEndpoint,
} from '../src/common/core/block-informer.js';
import { httpLib } from '../src/common/core/http-lib.js';
import { logger } from '../src/common/core/logger.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { appState } from '../src/common/core/app-state.js';

describe('BlockInformer & IpToHost', () => {
  let origHttpLibGet;

  before(() => {
    origHttpLibGet = httpLib.get;
    httpLib.get = async () => 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  });

  after(() => {
    httpLib.get = origHttpLibGet;
  });
  it('should identify known default proxy IPs in ipToHost', () => {
    expect(ipToHost.get('195.201.201.32')).to.include('proxy.antizapret.prostovpn.org');
    expect(ipToHost.get('127.0.0.1')).to.equal('localhost');
    expect(ipToHost.isProxyIp('51.158.176.144')).to.be.true;
    expect(ipToHost.get('8.8.8.8')).to.be.null;
  });
  it('does not publish a cold request after its tab stats were cleared', async () => {
    const original = appState.ensureRoutingStateInitialized;
    const initialized = appState.isRequestStateInitialized;
    const tabId = 4040;
    let release;
    appState.isRequestStateInitialized = false;
    appState.ensureRoutingStateInitialized = () => new Promise(resolve => { release = resolve; });
    try {
      const pending = blockInformer.handleRequest({ tabId, type: 'main_frame', url: 'https://example.test/',
        proxyInfo: { type: 'https', host: 'proxy.test', port: 443 } });
      blockInformer.clearTab(tabId);
      release();
      await pending;
      expect(blockInformer.getTabStats(tabId).count).to.equal(0);
    } finally {
      appState.isRequestStateInitialized = initialized;
      appState.ensureRoutingStateInitialized = original;
      blockInformer.clearTab(tabId);
    }
  });

  it('should dynamically register custom proxy IPs and hostnames', () => {
    // P2.4: '198.51.100.25:8080' contains a port so it is NOT a bare IPv4 address —
    // addHost with ips[] param is the correct way to map a specific IP to a proxy host
    ipToHost.addHost('198.51.100.25:8080', ['198.51.100.25']);
    expect(ipToHost.get('198.51.100.25')).to.equal('198.51.100.25:8080');

    ipToHost.updateFromPac('function FindProxyForURL() { return "HTTPS custom-proxy.net:443; SOCKS5 10.20.30.40:1080; DIRECT"; }');
    expect(ipToHost.get('10.20.30.40')).to.equal('10.20.30.40:1080');

    ipToHost.addHost('2001:db8::1');
    expect(ipToHost.get('2001:db8::1')).to.equal('2001:db8::1');
    ipToHost.addHost('not:a:valid:ipv6');
    expect(ipToHost.get('not:a:valid:ipv6')).to.equal(null);
  });

  it('should correctly track proxied hosts per tab in BlockInformer', () => {
    const tabId = 999;
    blockInformer.clearTab(tabId);

    blockInformer.recordProxiedHost(tabId, 'rutracker.org', 'proxy.antizapret.prostovpn.org:8443', true);
    let stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(1);
    expect(stats.hosts).to.include('rutracker.org');

    // Add another subdomain on same tab
    blockInformer.recordProxiedHost(tabId, 'static.rutracker.org', 'proxy.antizapret.prostovpn.org:8443', false);
    stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(2);
    expect(stats.hosts).to.include('rutracker.org');
    expect(stats.hosts).to.include('static.rutracker.org');

    // Clear tab on navigation
    blockInformer.clearTab(tabId);
    stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(0);
  });

  it('classifies own and PAC proxy endpoints without exposing credentials', () => {
    expect(normalizeProxyEndpoint('HTTPS user:secret@Own.Proxy:443'))
      .to.equal('own.proxy:443');
    expect(classifyProxySource(
      'own.proxy:443',
      'HTTPS own.proxy:443; SOCKS5 127.0.0.1:9150'
    )).to.equal('own');
    expect(classifyProxySource('127.0.0.1:9150', '')).to.equal('own');
    expect(classifyProxySource('proxy.antizapret.prostovpn.org:8443', ''))
      .to.equal('antizapret');
    expect(classifyProxySource('provider-proxy.example:443', ''))
      .to.equal('pac');
  });

  it('keeps the observed main-frame route for the current tab and domain', async () => {
    const tabId = 1000;
    blockInformer.clearTab(tabId);
    blockInformer.recordProxiedHost(
      tabId,
      'docs.github.com',
      'HTTPS own.proxy:443',
      true,
      'own',
      'observed'
    );

    expect(await blockInformer.getTabRoute(tabId, 'github.com')).to.include({
      kind: 'proxy',
      source: 'own',
      hostname: 'docs.github.com',
      proxyHost: 'own.proxy:443',
      confidence: 'observed',
    });
    expect(await blockInformer.getTabRoute(tabId, 'example.com')).to.equal(null);

    blockInformer.recordDirectRoute(tabId, 'docs.github.com');
    expect(await blockInformer.getTabRoute(tabId, 'github.com')).to.include({
      kind: 'direct',
      source: 'direct',
      confidence: 'observed',
    });
    blockInformer.clearTab(tabId);
  });

  it('should safely handle handleRequest even during cold start and ignore internal URLs', async () => {
    const tabId = 1001;
    blockInformer.clearTab(tabId);

    // Internal browser/extension URLs should be ignored
    await blockInformer.handleRequest({ tabId, url: 'chrome-extension://xyz/options.html', ip: '195.201.201.32' });
    let stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(0);

    // Proxy IP request
    await blockInformer.handleRequest({ tabId, url: 'https://rutracker.org/forum/index.php', ip: '195.201.201.32', type: 'main_frame' });
    stats = blockInformer.getTabStats(tabId);
    expect(stats.count).to.equal(1);
    expect(stats.hosts).to.include('rutracker.org');

    blockInformer.clearTab(tabId);
  });

  it('does not enumerate a large exception collection for each request', async () => {
    const tabId = 1002;
    const originalGetCachedMods = pacKitchen.getCachedMods;
    const originalRequestState = appState.isRequestStateInitialized;
    const exceptions = {};
    for (let i = 0; i < 33000; i++) {
      exceptions[`domain-${i}.example.com`] = true;
    }
    let ownKeysCalls = 0;
    const guardedExceptions = new Proxy(exceptions, {
      ownKeys(target) {
        ownKeysCalls++;
        return Reflect.ownKeys(target);
      },
    });

    blockInformer.clearTab(tabId);
    appState.isRequestStateInitialized = true;
    pacKitchen.getCachedMods = () => ({
      exceptions: guardedExceptions,
      filteredCustomsString: 'PROXY proxy.example:443',
    });

    try {
      await blockInformer.handleRequest({
        tabId,
        url: 'https://not-listed.example.net/resource.js',
        ip: '8.8.8.8',
        type: 'script',
      });

      expect(ownKeysCalls).to.equal(0);
      expect(blockInformer.getTabStats(tabId).count).to.equal(0);
    } finally {
      pacKitchen.getCachedMods = originalGetCachedMods;
      appState.isRequestStateInitialized = originalRequestState;
      blockInformer.clearTab(tabId);
    }
  });

  it('collects proxy statistics without writing toolbar state on resource events', () => {
    const tabId = 1003;
    const originalAction = chrome.action;
    const calls = { background: 0, text: 0, title: 0 };

    blockInformer.clearTab(tabId);
    chrome.action = {
      setBadgeBackgroundColor: (_options, callback) => {
        calls.background++;
        if (callback) callback();
      },
      setBadgeText: (_options, callback) => {
        calls.text++;
        if (callback) callback();
      },
      setTitle: (_options, callback) => {
        calls.title++;
        if (callback) callback();
      },
    };

    try {
      for (let i = 0; i < 100; i++) {
        blockInformer.recordProxiedHost(tabId, 'assets.example', 'proxy.example:443', false);
      }
      expect(calls).to.deep.equal({ background: 0, text: 0, title: 0 });

      blockInformer.recordProxiedHost(tabId, 'api.example', 'proxy.example:443', false);
      expect(calls).to.deep.equal({ background: 0, text: 0, title: 0 });

      blockInformer.recordProxiedHost(
        tabId,
        'assets.example',
        'proxy.example:443',
        true,
        'pac',
        'configured'
      );
      expect(calls).to.deep.equal({ background: 0, text: 0, title: 0 });
    } finally {
      chrome.action = originalAction;
      blockInformer.clearTab(tabId);
    }
  });

  it('uses the known-host fast path while retaining a newly observed endpoint', async () => {
    const tabId = 1004;
    const originalGetCachedMods = pacKitchen.getCachedMods;
    let modsReads = 0;
    pacKitchen.getCachedMods = () => {
      modsReads++;
      return { exceptions: {} };
    };
    blockInformer.clearTab(tabId);
    blockInformer.recordProxiedHost(
      tabId,
      'assets.example',
      'first.proxy.example:443',
      false
    );

    try {
      for (let i = 0; i < 100; i++) {
        await blockInformer.handleRequest({
          tabId,
          url: `https://assets.example/resource-${i}.js`,
          type: 'script',
        });
      }
      expect(modsReads).to.equal(0);

      await blockInformer.handleRequest({
        tabId,
        url: 'https://assets.example/new-endpoint.js',
        type: 'script',
        proxyInfo: {
          type: 'https',
          host: 'second.proxy.example',
          port: 443,
        },
      });
      expect(blockInformer.getTabStats(tabId).proxies)
        .to.include('second.proxy.example:443');
      expect(modsReads).to.equal(0);
    } finally {
      pacKitchen.getCachedMods = originalGetCachedMods;
      blockInformer.clearTab(tabId);
    }
  });

  it('does not retain private browsing requests in statistics, routes, or logs', async () => {
    const tabId = 1010;
    const originalAdd = logger.add;
    const entries = [];
    logger.add = (entry) => entries.push(entry);
    blockInformer.clearTab(tabId);
    try {
      const details = {
        tabId,
        incognito: true,
        url: 'https://private.example/sensitive',
        type: 'main_frame',
        proxyInfo: { type: 'https', host: 'proxy.example', port: 443 },
        error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
      };
      await blockInformer.handleRequest(details);
      await blockInformer.handleConnectionError(details);
      expect(blockInformer.getTabStats(tabId)).to.deep.equal({ count: 0, hosts: [], proxies: [] });
      expect(await blockInformer.getTabRoute(tabId)).to.equal(null);
      expect(entries).to.have.lengthOf(0);
    } finally {
      logger.add = originalAdd;
      blockInformer.clearTab(tabId);
    }
  });

  it('restores the journal before recording only top-level proxy request failures', async () => {
    const originalAdd = logger.add;
    const originalEnsure = appState.ensureLoggerInitialized;
    const entries = [];
    let restores = 0;
    appState.ensureLoggerInitialized = async () => { restores++; };
    logger.add = (entry) => {
      expect(restores).to.equal(1);
      entries.push(entry);
    };

    try {
      await blockInformer.handleConnectionError({
        tabId: 7,
        url: 'https://docs.github.com/en',
        error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
        type: 'main_frame',
      });
      await blockInformer.handleConnectionError({
        tabId: 7,
        url: 'https://github.githubassets.com/app.js',
        error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
        type: 'script',
      });
      await blockInformer.handleConnectionError({
        tabId: -1,
        url: 'https://1.1.1.1/cdn-cgi/trace',
        error: 'net::ERR_PROXY_CONNECTION_FAILED',
        type: 'xmlhttprequest',
      });

      expect(entries).to.have.lengthOf(1);
      expect(restores).to.equal(1);
      expect(entries[0]).to.include({
        level: 'warn',
        category: 'proxy',
        title: 'net::ERR_TUNNEL_CONNECTION_FAILED → docs.github.com',
        groupKey: 'net::ERR_TUNNEL_CONNECTION_FAILED|docs.github.com|main_frame',
      });
      expect(entries[0].message).to.include('отдельный запрос');
      expect(entries[0].message).to.include('не означает');
      expect(entries[0].details).to.deep.equal({
        error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
        domain: 'docs.github.com',
        type: 'main_frame',
      });
    } finally {
      logger.add = originalAdd;
      appState.ensureLoggerInitialized = originalEnsure;
    }
  });
});
