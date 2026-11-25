import { expect } from 'chai';
import vm from 'node:vm';
import { badgePresentation, ToolbarBadge } from '../src/common/core/toolbar-badge.js';
import { cookPac } from '../src/common/core/pac-script.js';
import { setupContextMenus } from '../src/common/core/context-menus.js';
import { blockInformer } from '../src/common/core/block-informer.js';
import { appState } from '../src/common/core/app-state.js';
import { errorHandlers } from '../src/common/core/error-handlers.js';
import { storage } from '../src/common/core/storage.js';
import { consumeProxyAuthAttempt, clearProxyAuthAttempts, setupAuthListener,
  registerTemporaryCredentials, unregisterTemporaryCredentials } from '../src/common/core/proxy-auth.js';

const state = mods => ({ sync: { currentPacProviderKey: 'onlyOwnSites' },
  application: {}, mods: { ifMindExceptions: true, ifUsePacScriptProxies: true,
    ifProxyOrDie: true, exceptions: {}, ...mods } });
const nativeRoute = (mods, host) => {
  const context = vm.createContext({});
  vm.runInContext(cookPac('function FindProxyForURL(){return "HTTPS native.test:443";}', mods), context);
  return context.FindProxyForURL(`https://${host}/`, host);
};

describe('Review runtime regressions', () => {
  let previousChrome;
  beforeEach(() => { previousChrome = globalThis.chrome; globalThis.chrome = { runtime: {} }; });
  afterEach(() => { globalThis.chrome = previousChrome; });

  it('1.3 shows configured list intent and keeps PAC bypass above a list', () => {
    for (const pacBypassDomains of [[], ['example.com']]) {
      const snapshot = state({ domainLists: [{ id: 'list', enabled: true, proxyId: 'a', domains: ['example.com'] }],
        proxyRoutes: { a: 'HTTPS a.test:443' }, pacBypassDomains });
      expect(nativeRoute(snapshot.mods, 'www.example.com')).to.equal(pacBypassDomains.length ? 'HTTPS native.test:443' : 'HTTPS a.test:443');
      expect(badgePresentation('https://www.example.com/', snapshot).text).to.equal(pacBypassDomains.length ? 'PAC' : 'P');
    }
  });

  it('1.3 honors manual subdomains, disabled gates, provenance and unavailable profile intent', () => {
    const base = { domainLists: [{ id: 'list', enabled: true, proxyId: 'missing', domains: ['example.com'] }],
      exceptions: { 'manual.example.com': false, 'asset.cdn.test': true },
      domainProxyIds: { 'asset.cdn.test': 'stale' }, proxyRoutes: {},
      ruleMeta: { 'exception:asset.cdn.test': { source: 'auto', site: 'example.com' },
        'proxy:asset.cdn.test': { source: 'auto', site: 'example.com' } } };
    for (const [host, text, expectedRoute] of [['example.com', 'P', 'PROXY 127.0.0.1:9'],
      ['manual.example.com', 'D', 'DIRECT'], ['asset.cdn.test', 'P', 'PROXY 127.0.0.1:9']]) {
      const snapshot = state(base);
      expect(nativeRoute(snapshot.mods, host)).to.equal(expectedRoute);
      expect(badgePresentation(`https://${host}/`, snapshot).text).to.equal(text);
    }
    for (const gate of [{ ifMindExceptions: false }, { ifNoMods: true, ifProxyOrDie: false }]) {
      expect(badgePresentation('https://example.com/', state({ ...base, ...gate })).text).to.equal('PAC');
    }
    expect(badgePresentation('https://example.com/', state({ ...base,
      domainLists: base.domainLists.map(list => ({ ...list, enabled: false })) })).text).to.equal('PAC');
  });

  it('1.9 ignores all non-HTTP(S) request diagnostics before initialization', async () => {
    const originalReady = appState.ensureRequestStateInitialized;
    const originalInitialized = appState.isRequestStateInitialized;
    let reads = 0;
    appState.isRequestStateInitialized = false;
    appState.ensureRequestStateInitialized = async () => { reads++; };
    try {
      for (const url of ['moz-extension://private/options.html', 'chrome://settings/', 'about:config',
        'file:///secret', 'data:text/plain,secret', 'ftp://private.test/file', 'invalid']) {
        await blockInformer.handleRequest({ tabId: 9011, url, type: 'main_frame',
          proxyInfo: { type: 'https', host: 'proxy.test', port: 443 } });
      }
      expect(reads).to.equal(0);
      expect(blockInformer.getTabStats(9011).count).to.equal(0);
    } finally {
      appState.ensureRequestStateInitialized = originalReady;
      appState.isRequestStateInitialized = originalInitialized;
      blockInformer.clearTab(9011);
    }
  });

  it('1.10 translates only web pages without credentials, source auto and UI target locale', () => {
    let click;
    const opened = [];
    let locale = 'ru';
    chrome.i18n = { getMessage: key => key === 'uiLanguage' ? locale : '', getUILanguage: () => locale };
    chrome.contextMenus = { onClicked: { addListener: callback => { click = callback; } } };
    chrome.tabs = { create: details => opened.push(details.url) };
    setupContextMenus();
    for (const url of ['chrome://settings/', 'about:config', 'moz-extension://private/options',
      'file:///secret', 'https://user:secret@example.com/private', '', 'invalid']) {
      click({ menuItemId: 'google-translate' }, { url });
    }
    click({ menuItemId: 'google-translate' });
    expect(opened).to.have.lengthOf(0);
    for (locale of ['ru', 'en']) {
      const source = 'https://example.com/path?q=a&x=b#part';
      click({ menuItemId: 'google-translate' }, { url: source });
      const target = new URL(opened.at(-1));
      expect(target.origin).to.equal('https://translate.google.com');
      expect(target.searchParams.get('sl')).to.equal('auto');
      expect(target.searchParams.get('tl')).to.equal(locale);
      expect(target.searchParams.get('u')).to.equal(source);
    }
  });

  it('1.11 rejects arbitrary notification fields without writing and preserves every existing key', async () => {
    const originalSet = storage.set;
    const listenersRegistered = errorHandlers._listenersRegistered;
    const reads = [];
    let writes = 0;
    chrome.storage = { local: { get: (key, callback) => { reads.push(key); callback({}); } } };
    storage.set = async () => { writes++; };
    errorHandlers.resetRuntimeState();
    try {
      const before = { ...errorHandlers.notificationsEnabled };
      for (const key of ['unknown', '__proto__', 'constructor', null, ['pac-error']]) {
        let rejected = false;
        try { await errorHandlers.setNotificationOption(key, false); } catch { rejected = true; }
        expect(rejected, String(key)).to.equal(true);
      }
      expect(writes).to.equal(0);
      expect(reads).to.deep.equal([]);
      expect(errorHandlers.notificationsEnabled).to.deep.equal(before);
      for (const key of Object.keys(before)) {
        await errorHandlers.setNotificationOption(key, false);
        expect(errorHandlers.notificationsEnabled[key]).to.equal(false);
      }
      expect(writes).to.equal(Object.keys(before).length);
      expect(reads).to.deep.equal(['handlers-state']);
    } finally {
      storage.set = originalSet;
      errorHandlers.resetRuntimeState();
      errorHandlers._listenersRegistered = listenersRegistered;
    }
  });

  it('2.1 bounds fallback memory without evicting active retry limits and expires it by TTL', async () => {
    await clearProxyAuthAttempts();
    for (let i = 0; i < 500; i++) await consumeProxyAuthAttempt(`full-${i}`, 1000);
    expect(await consumeProxyAuthAttempt('overflow', 1000)).to.deep.equal({ allowed: false, tries: 0 });
    expect(await consumeProxyAuthAttempt('full-0', 1001)).to.deep.equal({ allowed: true, tries: 2 });
    expect(await consumeProxyAuthAttempt('full-0', 1002)).to.deep.equal({ allowed: true, tries: 3 });
    expect(await consumeProxyAuthAttempt('full-0', 1003)).to.deep.equal({ allowed: false, tries: 3 });
    expect(await consumeProxyAuthAttempt('overflow', 61003)).to.deep.equal({ allowed: true, tries: 1 });
    await clearProxyAuthAttempts();
  });

  it('2.1 clears only the completed request while concurrent fallback requests keep their limits', async () => {
    await clearProxyAuthAttempts();
    await Promise.all(['a', 'b'].flatMap(id => Array.from({ length: 3 }, () => consumeProxyAuthAttempt(id))));
    await clearProxyAuthAttempts('a');
    expect((await consumeProxyAuthAttempt('a')).tries).to.equal(1);
    expect(await consumeProxyAuthAttempt('b')).to.deep.equal({ allowed: false, tries: 3 });
    await clearProxyAuthAttempts();
  });

  it('3.1 preserves callback auth without session storage and the synchronous compatibility wrapper', async () => {
    await clearProxyAuthAttempts();
    let listener;
    chrome.webRequest = { onAuthRequired: { addListener: callback => { listener = callback; } } };
    registerTemporaryCredentials('proxy.test', 443, 'user', 'secret');
    setupAuthListener(async () => {});
    const details = { requestId: 'challenge', isProxy: true, incognito: true, challenger: { host: 'proxy.test', port: 443 } };
    try {
      for (let i = 0; i < 4; i++) {
        const result = await new Promise(resolve => listener(details, resolve));
        expect(result).to.deep.equal(i < 3 ? { authCredentials: { username: 'user', password: 'secret' } } : { cancel: true });
      }
      for (let i = 0; i < 4; i++) {
        expect(listener({ ...details, requestId: 'sync' })).to.deep.equal(i < 3 ?
          { authCredentials: { username: 'user', password: 'secret' } } : { cancel: true });
      }
    } finally { unregisterTemporaryCredentials(); await clearProxyAuthAttempts(); }
  });

  it('2.1 also bounds and expires the reachable synchronous compatibility retry cache', () => {
    let listener, now = 1000;
    const originalNow = Date.now, originalLog = console.log, originalWarn = console.warn;
    chrome.webRequest = { onAuthRequired: { addListener: callback => { listener = callback; } } };
    registerTemporaryCredentials('proxy.test', 443, 'user', 'secret');
    setupAuthListener(async () => {});
    const details = { isProxy: true, incognito: true, challenger: { host: 'proxy.test', port: 443 } };
    try {
      Date.now = () => now; console.log = () => {}; console.warn = () => {};
      for (let i = 0; i < 500; i++) expect(listener({ ...details, requestId: `sync-${i}` })).to.have.property('authCredentials');
      expect(listener({ ...details, requestId: 'overflow' })).to.deep.equal({ cancel: true });
      for (let i = 0; i < 2; i++) expect(listener({ ...details, requestId: 'sync-0' })).to.have.property('authCredentials');
      expect(listener({ ...details, requestId: 'sync-0' })).to.deep.equal({ cancel: true });
      now = 100000;
      expect(listener({ ...details, requestId: 'overflow' })).to.have.property('authCredentials');
    } finally {
      Date.now = originalNow; console.log = originalLog; console.warn = originalWarn;
      unregisterTemporaryCredentials();
    }
  });

  it('1.4 refutes missing optional badge API TypeError using the real adapter', async () => {
    const writes = [];
    chrome.tabs = { query: (_, callback) => callback([{ id: 1, url: 'https://example.com/' }]) };
    chrome.action = Object.fromEntries(['setBadgeText', 'setBadgeBackgroundColor', 'setTitle'].map(name =>
      [name, (details, callback) => { writes.push({ name, ...details }); callback(); }]));
    const toolbar = new ToolbarBadge(async () => state({}));
    await toolbar.refresh();
    expect(writes).to.have.lengthOf(3);
    expect(toolbar.presentations.has(1)).to.equal(true);
  });
});
