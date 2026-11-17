import { expect } from 'chai';
import vm from 'node:vm';
import { cookPac } from '../src/common/core/pac-script.js';
import { setupMessageBus, serializePacMods } from '../src/common/core/message-bus.js';
import { appState } from '../src/common/core/app-state.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { SiteResources, siteResources } from '../src/common/core/site-resources.js';
import { blockInformer } from '../src/common/core/block-informer.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';
import { TabProxyRouter } from '../src/common/core/tab-proxy-router.js';

describe('Current-site selection RPC and real settings queue', () => {
  let original;
  let listener;
  let tracker;
  let applications;
  let tab;
  beforeEach(() => {
    original = { chrome: globalThis.chrome, local: appState.ensureLocalStateInitialized,
      apply: settingsCoordinator.apply, state: settingsCoordinator.state,
      setMode: siteResources.setMode, resetResourceRule: siteResources.resetResourceRule, setInheritance: siteResources.setInheritance, summary: siteResources.summary, clear: blockInformer.clearTab,
      platform: proxyBackend.platform, settings: proxyBackend.getSettings };
    const data = {};
    tab = { id: 7, url: 'https://www.site.test/' };
    globalThis.chrome = { runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`,
      onMessage: { addListener: callback => { listener = callback; } } },
    tabs: { query: (_, cb) => cb([tab]), get: (_, cb) => cb(tab) },
    storage: { local: {
      get: (key, cb) => cb({ [key]: data[key] }),
      set: (items, cb) => { Object.assign(data, items); cb(); },
    } } };
    applications = 0;
    appState.ensureLocalStateInitialized = async () => {};
    settingsCoordinator.apply = async () => { applications++; return { pending: false }; };
    settingsCoordinator.state = async () => ({ pending: false });
    blockInformer.clearTab = () => {};
    proxyBackend.platform = 'chrome';
    proxyBackend.getSettings = async () => ({ levelOfControl: 'controlled_by_this_extension', value: { proxyType: 'autoConfig' } });
    tracker = new SiteResources();
    tracker.schedule = () => {};
    siteResources.setMode = tracker.setMode.bind(tracker);
    siteResources.resetResourceRule = tracker.resetResourceRule.bind(tracker);
    siteResources.setInheritance = tracker.setInheritance.bind(tracker);
    siteResources.summary = tracker.summary.bind(tracker);
    pacKitchen.invalidateCache();
    setupMessageBus();
  });
  afterEach(() => {
    globalThis.chrome = original.chrome;
    appState.ensureLocalStateInitialized = original.local;
    settingsCoordinator.apply = original.apply;
    settingsCoordinator.state = original.state;
    siteResources.setMode = original.setMode;
    siteResources.resetResourceRule = original.resetResourceRule;
    siteResources.setInheritance = original.setInheritance;
    siteResources.summary = original.summary;
    blockInformer.clearTab = original.clear;
    proxyBackend.platform = original.platform;
    proxyBackend.getSettings = original.settings;
    pacKitchen.invalidateCache();
  });
  const send = message => new Promise(resolve => listener(message, { id: 'test' }, resolve));
  const choose = (proxyId, expectedRevision, expectedHost) => send({ action: 'SET_SITE_ROUTE', currentTabId: 7,
    domain: 'site.test', isProxy: true, proxyId, expectedRevision, expectedHost });
  async function seed() {
    await pacKitchen.updatePacMods(current => ({ ...current,
      customProxyStringRaw: 'HTTPS a.test:443; HTTPS b.test:443' }));
    const [a, b] = (await pacKitchen.getPacMods()).proxyProfiles.map(profile => profile.id);
    return { a, b };
  }

  const resetResource = (host, expectedRevision, extra = {}) => send({ action: 'RESET_RESOURCE_RULE',
    currentTabId: 7, domain: 'site.test', host, expectedRevision, expectedHost: 'www.site.test', ...extra });

  it('stores manual PAC intent through the existing site RPC instead of merely deleting its proxy rule', async () => {
    const { a } = await seed();
    expect((await choose(a)).success).to.equal(true);
    const raw = await pacKitchen.getRawPacMods();
    const result = await send({ action: 'SET_SITE_ROUTE', currentTabId: 7, domain: 'site.test',
      isProxy: null, expectedRevision: raw._rulesRevision, expectedHost: 'www.site.test' });
    expect(result.success).to.equal(true);
    const next = await pacKitchen.getRawPacMods();
    expect(next.pacBypassDomains).to.include('site.test').and.include('www.site.test');
    expect(next.exceptions).not.to.have.property('site.test');
    expect(next.domainProxyIds).not.to.have.property('site.test');
  });

  it('keeps explicit whole-site DIRECT/proxy above an exact main-host list through persisted provenance', async () => {
    const { a, b } = await seed();
    await pacKitchen.updatePacMods(current => ({ ...current, domainLists: [
      { id: 'list:main', name: 'Main', enabled: true, proxyId: b, domains: ['www.site.test', 'asset.cdn.test'] },
    ] }));
    for (const isProxy of [false, true]) {
      const before = await pacKitchen.getRawPacMods();
      const result = await send({ action: 'SET_SITE_ROUTE', currentTabId: 7, domain: 'site.test',
        isProxy, ...(isProxy ? { proxyId: a } : {}), expectedRevision: before._rulesRevision,
        expectedHost: 'www.site.test' });
      expect(result.success).to.equal(true);
      // Reload the compact persisted snapshot, not just the in-memory result.
      pacKitchen.invalidateCache();
      const mods = await pacKitchen.getPacMods();
      const ctx = vm.createContext({});
      vm.runInContext(cookPac('function FindProxyForURL(){return "DIRECT";}', mods), ctx);
      expect(ctx.FindProxyForURL('https://www.site.test/', 'www.site.test')).to.equal(isProxy ? 'HTTPS a.test:443' : 'DIRECT');
      expect(ctx.FindProxyForURL('https://asset.cdn.test/', 'asset.cdn.test')).to.equal('HTTPS b.test:443');
      expect(mods.domainLists[0].domains).to.deep.equal(['www.site.test', 'asset.cdn.test']);
    }
  });

  it('persists the exact main-host list origin of automatic resources through rebind and last-list deletion', async () => {
    const { a, b } = await seed();
    const list = { id: 'list:main', name: 'Main', enabled: true, proxyId: a, domains: ['www.site.test'] };
    await pacKitchen.updatePacMods(current => ({ ...current, domainLists: [list] }));
    await tracker.observe({ tabId: 7, url: 'https://asset.cdn.test/a', type: 'image' });
    await tracker.flush();
    pacKitchen.invalidateCache();
    const stored = await pacKitchen.getRawPacMods();
    expect(stored.ruleMeta['exception:asset.cdn.test']).to.include({ source: 'auto',
      inheritedListId: list.id, inheritedMainHost: 'www.site.test' });
    for (const domainLists of [[{ ...list, proxyId: b }], [{ ...list, enabled: false }], []]) {
      await pacKitchen.updatePacMods(current => ({ ...current, domainLists }));
      pacKitchen.invalidateCache();
      const ctx = vm.createContext({});
      vm.runInContext(cookPac('function FindProxyForURL(){return "DIRECT";}', await pacKitchen.getPacMods()), ctx);
      expect(ctx.FindProxyForURL('https://asset.cdn.test/a', 'asset.cdn.test')).to.equal(
        domainLists[0]?.enabled ? 'HTTPS b.test:443' : 'DIRECT');
    }
  });

  it('reset RPC removes exact B but preserves the remaining wildcard A and rejects repeat reset atomically', async () => {
    const { a, b } = await seed();
    await pacKitchen.updatePacMods(current => ({ ...current,
      exceptions: { 'site.test': true, '*.cdn.test': true, 'img.cdn.test': true },
      domainProxyIds: { 'site.test': a, '*.cdn.test': a, 'img.cdn.test': b } }), { source: 'manual' });
    await tracker.observe({ tabId: 7, url: 'https://img.cdn.test/x', type: 'image' });
    const before = await pacKitchen.getPacMods();
    const wildcardMeta = before.ruleMeta['exception:*.cdn.test'];
    const response = await resetResource('img.cdn.test', before.rulesRevision);
    expect(response.success).to.equal(true);
    expect(response.data.siteResources.routes['img.cdn.test']).to.include({ origin: 'manual', ruleKey: '*.cdn.test', canResetExact: false, proxyId: a });
    const after = await pacKitchen.getRawPacMods();
    expect(after.exceptions).to.deep.equal({ 'site.test': true, '*.cdn.test': true });
    expect(after.domainProxyIds).to.deep.equal({ 'site.test': a, '*.cdn.test': a });
    expect(after.ruleMeta['exception:*.cdn.test']).to.equal(wildcardMeta);
    expect(after._rulesRevision).to.equal(before.rulesRevision + 1);
    expect((await resetResource('img.cdn.test', after._rulesRevision)).errorCode).to.equal('REVISION_CONFLICT');
    expect(await pacKitchen.getRawPacMods()).to.equal(after);
    expect(applications).to.equal(1);
  });

  it('reset never rewrites an automatic broad wildcard while recomputing the exact host', async () => {
    const { a } = await seed();
    await pacKitchen.updatePacMods(current => ({ ...current, exceptions: { 'site.test': false, '*.cdn.test': true },
      domainProxyIds: { '*.cdn.test': a } }), { source: 'auto', site: 'site.test' });
    await pacKitchen.updatePacMods(current => ({ ...current, exceptions: { ...current.exceptions, 'img.cdn.test': true },
      domainProxyIds: { ...current.domainProxyIds, 'img.cdn.test': a } }), { source: 'manual' });
    await tracker.observe({ tabId: 7, url: 'https://img.cdn.test/x', type: 'image' });
    const before = await pacKitchen.getPacMods();
    const response = await resetResource('img.cdn.test', before.rulesRevision);
    expect(response.success).to.equal(true);
    const after = await pacKitchen.getPacMods();
    expect(after.exceptions['*.cdn.test']).to.equal(true);
    expect(after.domainProxyIds['*.cdn.test']).to.equal(a);
    expect(after.ruleMeta['exception:*.cdn.test']).to.equal(before.ruleMeta['exception:*.cdn.test']);
    expect(after.exceptions['img.cdn.test']).to.equal(false);
  });

  it('reset validates canonical exact observed resources and strict revisions without writes', async () => {
    await seed();
    await pacKitchen.updatePacMods(current => ({ ...current, exceptions: { 'cdn.test': false, 'unknown.test': false, '*.cdn.test': true } }));
    await tracker.observe({ tabId: 7, url: 'https://cdn.test/x', type: 'image' });
    const before = await pacKitchen.getRawPacMods();
    const revision = before._rulesRevision;
    for (const host of ['site.test', 'www.site.test', '*.cdn.test', 'https://cdn.test/', 'CDN.test', 'cdn.test.', '127.0.0.1', 'unknown.test']) {
      expect((await resetResource(host, revision)).success, host).to.equal(false);
    }
    for (const invalid of [undefined, null, true, false, '2', -1, 1.5]) {
      expect((await resetResource('cdn.test', invalid)).errorCode).to.equal('REVISION_CONFLICT');
    }
    for (const extra of [{ currentTabId: null }, { expectedHost: 'other.site.test' }, { domain: 'other.test' }]) {
      expect((await resetResource('cdn.test', revision, extra)).success).to.equal(false);
    }
    for (const patch of [{ ifMindExceptions: false }, { ifNoMods: true }]) {
      await pacKitchen.updatePacMods(current => ({ ...current, ...patch }));
      const blocked = await pacKitchen.getRawPacMods();
      expect((await resetResource('cdn.test', blocked._rulesRevision)).errorCode).to.equal('RESOURCE_INHERITANCE_UNAVAILABLE');
      expect(await pacKitchen.getRawPacMods()).to.equal(blocked);
      await pacKitchen.updatePacMods(() => before);
    }
    tab.incognito = true;
    expect((await resetResource('cdn.test', (await pacKitchen.getPacMods()).rulesRevision)).success).to.equal(false);
    expect(applications).to.equal(0);
  });

  for (const race of ['host', 'revision', 'membership']) {
    it(`reset revalidates ${race} inside the real settings queue`, async () => {
      await seed();
      await pacKitchen.updatePacMods(current => ({ ...current, exceptions: { 'cdn.test': false } }));
      await tracker.observe({ tabId: 7, url: 'https://cdn.test/x', type: 'image' });
      let unblock, entered, readTab;
      const gate = new Promise(resolve => { unblock = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      const tabRead = new Promise(resolve => { readTab = resolve; });
      const before = await pacKitchen.getPacMods();
      const blocker = pacKitchen.updatePacMods(async current => {
        entered(); await gate;
        return race === 'revision' ? { ...current, exceptions: { ...current.exceptions, 'competing.test': true } } : current;
      });
      await started;
      chrome.tabs.get = (_, cb) => { cb({ ...tab }); readTab(); };
      const pending = resetResource('cdn.test', before.rulesRevision);
      await tabRead;
      if (race === 'host') tab.url = 'https://cdn.site.test/';
      if (race === 'membership') tracker.tabs.get(7).hosts.delete('cdn.test');
      unblock();
      await blocker;
      expect((await pending).errorCode).to.equal('REVISION_CONFLICT');
      expect((await pacKitchen.getPacMods()).exceptions['cdn.test']).to.equal(false);
      expect(applications).to.equal(0);
    });
  }

  for (const platform of ['chrome', 'firefox']) {
    for (const enabled of [true, false]) {
      it(`${platform}: reset returns exact B to parent A or policy DIRECT immediately and after cold load (${enabled})`, async () => {
        proxyBackend.platform = platform;
        const { a, b } = await seed();
        await pacKitchen.updatePacMods(current => ({ ...current,
          exceptions: { 'site.test': true, 'cdn.test': true }, domainProxyIds: { 'site.test': a, 'cdn.test': b },
          siteResourceInheritance: enabled ? {} : { 'site.test': false } }), { source: 'manual' });
        await tracker.observe({ tabId: 7, url: 'https://cdn.test/x', type: 'image' });
        const before = await pacKitchen.getPacMods();
        const response = await resetResource('cdn.test', before.rulesRevision);
        expect(response.success).to.equal(true);
        expect(response.data.siteResources.routes['cdn.test']).to.include({ origin: 'site', canResetExact: false,
          mode: enabled ? 'proxy' : 'direct', proxyId: enabled ? a : null });
        pacKitchen.invalidateCache();
        const mods = await pacKitchen.getPacMods();
        expect(mods.rulesRevision).to.equal(before.rulesRevision + 1);
        expect(mods.ruleMeta['exception:cdn.test']).to.include({ source: 'auto', site: 'site.test' });
        expect(mods.ruleMeta['exception:cdn.test'].suppressAuto).not.to.equal(true);
        const context = vm.createContext({});
        vm.runInContext(cookPac('function FindProxyForURL(){return "HTTPS pac.test:443";}', mods), context);
        expect(context.FindProxyForURL('https://cdn.test/', 'cdn.test')).to.equal(enabled ? 'HTTPS a.test:443' : 'DIRECT');
        const router = new TabProxyRouter();
        router.tabs.set(7, 'www.site.test');
        const actual = await router.handle({ tabId: 7, type: 'image', url: 'https://cdn.test/' });
        if (enabled) expect(actual[0].host).to.equal('a.test');
        else expect(actual).to.equal(null);
        expect((await resetResource('cdn.test', mods.rulesRevision)).errorCode).to.equal('REVISION_CONFLICT');
      });
    }
  }

  it('reset clears both PAC tombstones provider-only without creating proxy profiles or suppressing discovery', async () => {
    await pacKitchen.updatePacMods(current => ({ ...current, exceptions: {}, ruleMeta: {
      'exception:cdn.test': { source: 'manual', revision: 0, suppressAuto: true },
      'proxy:cdn.test': { source: 'undo', revision: 0, suppressAuto: true },
    } }), { metadataOnly: true });
    await tracker.observe({ tabId: 7, url: 'https://cdn.test/x', type: 'image' });
    const before = await pacKitchen.getPacMods();
    expect((await tracker.summary(7, 'site.test')).routes['cdn.test']).to.include({ origin: 'manual', canResetExact: true });
    expect((await resetResource('cdn.test', before.rulesRevision)).success).to.equal(true);
    pacKitchen.invalidateCache();
    const mods = await pacKitchen.getPacMods();
    expect(mods.exceptions).to.deep.equal({});
    expect(mods.domainProxyIds).to.deep.equal({});
    expect(mods.proxyProfiles).to.deep.equal(before.proxyProfiles);
    expect(mods.ruleMeta['exception:cdn.test'].suppressAuto).not.to.equal(true);
    expect(mods.ruleMeta['proxy:cdn.test']?.suppressAuto).not.to.equal(true);
    expect((await tracker.summary(7, 'site.test')).canInheritResources).to.equal(false);
    const context = vm.createContext({});
    vm.runInContext(cookPac('function FindProxyForURL(){return "HTTPS pac.test:443";}', mods), context);
    expect(context.FindProxyForURL('https://cdn.test/', 'cdn.test')).to.contain('pac.test');
    await seed();
    await pacKitchen.updatePacMods(current => ({ ...current, exceptions: { 'site.test': false } }));
    await tracker.reconsider();
    await tracker.flush();
    expect((await pacKitchen.getPacMods()).exceptions['cdn.test']).to.equal(false);
  });

  it('serializes the rules revision for popup optimistic concurrency', () => {
    expect(serializePacMods({ rulesRevision: 42 }).rulesRevision).to.equal(42);
  });

  it('rejects same-root navigation after the popup precheck without touching a manual resource', async () => {
    const { a, b } = await seed();
    await pacKitchen.updatePacMods(current => ({ ...current, exceptions: { 'api.site.test': true },
      domainProxyIds: { 'api.site.test': a } }), { source: 'manual' });
    const before = await pacKitchen.getRawPacMods();
    tab.url = 'https://api.site.test/';
    const result = await choose(b, undefined, 'www.site.test');
    expect(result.success).to.equal(false);
    expect(await pacKitchen.getRawPacMods()).to.equal(before);
    expect(applications).to.equal(0);
  });

  it('rechecks the expected host inside the settings write queue', async () => {
    const { a, b } = await seed();
    await pacKitchen.updatePacMods(current => ({ ...current, exceptions: { 'api.site.test': true },
      domainProxyIds: { 'api.site.test': a } }), { source: 'manual' });
    let unblock, entered, readTab;
    const gate = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const tabRead = new Promise(resolve => { readTab = resolve; });
    const blocker = pacKitchen.updatePacMods(async current => { entered(); await gate; return current; });
    await started;
    chrome.tabs.get = (_, cb) => { cb({ ...tab }); readTab(); };
    const request = choose(b, undefined, 'www.site.test');
    await tabRead;
    tab.url = 'https://api.site.test/';
    unblock();
    await blocker;
    const result = await request;
    expect(result.success).to.equal(false);
    const mods = await pacKitchen.getPacMods();
    expect(mods.domainProxyIds['api.site.test']).to.equal(a);
    expect(mods.ruleMeta['exception:api.site.test'].source).to.equal('manual');
    expect(mods.exceptions).not.to.have.property('www.site.test');
    expect(applications).to.equal(0);
  });

  it('returns REVISION_CONFLICT without saving or applying a stale popup selection; legacy calls still work', async () => {
    const { a, b } = await seed();
    const revision = (await pacKitchen.getPacMods()).rulesRevision;
    expect((await choose(a, revision)).success).to.equal(true);
    const before = await pacKitchen.getRawPacMods();
    const result = await choose(b, revision);
    expect(result.success).to.equal(false);
    expect(result.errorCode).to.equal('REVISION_CONFLICT');
    expect(await pacKitchen.getRawPacMods()).to.equal(before);
    expect(applications).to.equal(1);
    expect((await choose(b)).success).to.equal(true);
    expect((await pacKitchen.getPacMods()).domainProxyIds['site.test']).to.equal(b);
    expect(applications).to.equal(2);
  });

  const inheritance = (enabled, expectedRevision, expectedHost = 'www.site.test') => send({
    action: 'SET_SITE_RESOURCE_INHERITANCE', currentTabId: 7, domain: 'site.test', enabled, expectedRevision, expectedHost });

  it('repairs a malformed persisted policy on cold load without rewriting its rules revision', async () => {
    await seed();
    const stored = await new Promise(resolve => chrome.storage.local.get('pac-kitchen-mods', resolve));
    const packed = stored['pac-kitchen-mods'];
    packed.siteResourceInheritance = JSON.parse('{"site.test":false,"*.site.test":false,"a.site.test":false,"co.uk":false,"github.io":false,"constructor":false,"bad.test":null}');
    pacKitchen.invalidateCache();
    const mods = await pacKitchen.getPacMods();
    expect(mods.siteResourceInheritance).to.deep.equal({ 'site.test': false });
    expect(mods.rulesRevision).to.equal(packed._rulesRevision);
    const saved = await new Promise(resolve => chrome.storage.local.get('pac-kitchen-mods', resolve));
    expect(saved['pac-kitchen-mods'].siteResourceInheritance).to.deep.equal({ 'site.test': false });
  });

  it('requires strict checkbox fields and prevents SAVE_MODS from bypassing the dedicated boundary', async () => {
    await seed();
    const before = await pacKitchen.getRawPacMods();
    for (const enabled of [undefined, null, 0, 'false']) {
      expect((await inheritance(enabled, before._rulesRevision)).success).to.equal(false);
    }
    for (const revision of [undefined, null, -1, '0']) {
      expect((await inheritance(false, revision)).success).to.equal(false);
    }
    expect((await inheritance(false, before._rulesRevision, undefined)).success).to.equal(true);
    const saved = await pacKitchen.getRawPacMods();
    const response = await send({ action: 'SAVE_MODS', mods: { siteResourceInheritance: { 'other.test': false } } });
    expect(response.success).to.equal(false);
    expect(await pacKitchen.getRawPacMods()).to.equal(saved);
  });

  it('rechecks the checkbox revision inside the global write queue after a competing rule edit', async () => {
    await seed();
    let unblock, entered, readTab;
    const gate = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const tabRead = new Promise(resolve => { readTab = resolve; });
    const before = await pacKitchen.getPacMods();
    const blocker = pacKitchen.updatePacMods(async current => {
      entered(); await gate;
      return { ...current, exceptions: { ...current.exceptions, 'competing.test': false } };
    });
    await started;
    chrome.tabs.get = (_, cb) => { cb({ ...tab }); readTab(); };
    const pending = inheritance(false, before.rulesRevision);
    await tabRead;
    unblock();
    await blocker;
    expect((await pending).errorCode).to.equal('REVISION_CONFLICT');
    const after = await pacKitchen.getPacMods();
    expect(after.exceptions['competing.test']).to.equal(false);
    expect(after.siteResourceInheritance).to.deep.equal({});
    expect(applications).to.equal(0);
  });

  it('rechecks the checkbox host/root inside the real global write queue', async () => {
    await seed();
    let unblock, entered, readTab;
    const gate = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const tabRead = new Promise(resolve => { readTab = resolve; });
    const blocker = pacKitchen.updatePacMods(async current => { entered(); await gate; return current; });
    await started;
    chrome.tabs.get = (_, cb) => { cb({ ...tab }); readTab(); };
    const pending = inheritance(false, (await pacKitchen.getPacMods()).rulesRevision);
    await tabRead;
    tab.url = 'https://api.site.test/';
    unblock();
    await blocker;
    expect((await pending).errorCode).to.equal('REVISION_CONFLICT');
    expect((await pacKitchen.getPacMods()).siteResourceInheritance).to.deep.equal({});
    expect(applications).to.equal(0);
  });

  for (const platform of ['chrome', 'firefox']) {
    it(`${platform}: checkbox never replaces a disabled manual resource assignment with default or DIRECT`, async () => {
      proxyBackend.platform = platform;
      const { a } = await seed();
      await pacKitchen.updatePacMods(current => ({ ...current, ifUseLocalTor: true, ifProxyOrDie: false,
        exceptions: { 'site.test': true, '*.manual.test': true },
        domainProxyIds: { 'site.test': a, '*.manual.test': 'builtin:tor' } }), { source: 'manual' });
      await pacKitchen.updatePacMods(current => ({ ...current, ifUseLocalTor: false }));
      const router = new TabProxyRouter();
      router.tabs.set(7, 'www.site.test');
      for (const enabled of [false, true]) {
        const revision = (await pacKitchen.getPacMods()).rulesRevision;
        expect((await inheritance(enabled, revision)).success).to.equal(true);
        const mods = await pacKitchen.getPacMods();
        expect(mods.domainProxyIds['*.manual.test']).to.equal('builtin:tor');
        expect(mods.exceptions['*.manual.test']).to.equal(true);
        const request = await router.handle({ tabId: 7, type: 'image', url: 'https://img.manual.test/' });
        expect(request[0].host).to.equal('127.0.0.1');
        const context = vm.createContext({});
        vm.runInContext(cookPac('function FindProxyForURL(){return "DIRECT";}', mods), context);
        const route = context.FindProxyForURL('https://img.manual.test/', 'img.manual.test');
        expect(route).not.to.match(/DIRECT|a\.test|b\.test/);
      }
    });

    it(`${platform}: PAC parent off/on removes owned DIRECT without inventing a parent proxy`, async () => {
      proxyBackend.platform = platform;
      await seed();
      await pacKitchen.updatePacMods(current => ({ ...current, exceptions: { 'saved.test': false },
        siteResourceInheritance: { 'site.test': false } }), { source: 'auto', site: 'site.test' });
      let mods = await pacKitchen.getPacMods();
      expect((await inheritance(true, mods.rulesRevision)).success).to.equal(true);
      mods = await pacKitchen.getPacMods();
      expect(mods.exceptions).to.deep.equal({});
      expect(mods.domainProxyIds).to.deep.equal({});
      const context = vm.createContext({});
      vm.runInContext(cookPac('function FindProxyForURL(){return "HTTPS pac.test:443";}', mods), context);
      expect(context.FindProxyForURL('https://saved.test/', 'saved.test')).to.equal(
        context.FindProxyForURL('https://unconfigured.test/', 'unconfigured.test'));
      expect(context.FindProxyForURL('https://saved.test/', 'saved.test')).to.contain('HTTPS pac.test:443');
      const router = new TabProxyRouter();
      router.tabs.set(7, 'www.site.test');
      expect(await router.handle({ tabId: 7, type: 'image', url: 'https://unknown.test/' })).to.equal(undefined);
      expect((await inheritance(false, mods.rulesRevision)).success).to.equal(true);
      mods = await pacKitchen.getPacMods();
      expect(mods.exceptions).not.to.have.property('site.test');
      expect(mods.exceptions).not.to.have.property('www.site.test');
      expect(mods.domainProxyIds).to.deep.equal({});
      expect(await router.handle({ tabId: 7, type: 'image', url: 'https://unknown.test/' })).to.equal(null);
    });

    it(`${platform}: checkbox policy is durable and applies real PAC/runtime with manual wildcard priority`, async () => {
      proxyBackend.platform = platform;
      const { a, b } = await seed();
      await pacKitchen.updatePacMods(current => ({ ...current,
        exceptions: { 'site.test': true, '*.site.test': true, 'manual.test': true, 'direct.test': false },
        domainProxyIds: { 'site.test': a, '*.site.test': b, 'manual.test': a } }), { source: 'manual' });
      await pacKitchen.updatePacMods(current => ({ ...current,
        exceptions: { ...current.exceptions, 'saved.test': true },
        domainProxyIds: { ...current.domainProxyIds, 'saved.test': a } }), { source: 'auto', site: 'site.test' });
      const before = await pacKitchen.getPacMods();
      await tracker.observe({ tabId: 7, url: 'https://cdn.site.test/x', type: 'image' });
      await tracker.observe({ tabId: 7, url: 'https://fresh.test/x', type: 'image' });
      const result = await inheritance(false, before.rulesRevision);
      expect(result.success).to.equal(true);
      expect(result.data.siteResources).to.include({ inheritResources: false, canInheritResources: true });
      let mods = await pacKitchen.getPacMods();
      expect(mods.rulesRevision).to.equal(before.rulesRevision + 1);
      expect(mods.domainProxyIds).to.include({ 'site.test': a, '*.site.test': b, 'manual.test': a });
      expect(mods.exceptions).not.to.have.property('cdn.site.test');
      expect(mods.exceptions['saved.test']).to.equal(false);
      expect(serializePacMods(mods)).not.to.have.property('siteResourceInheritance');
      const writes = applications;
      expect((await inheritance(true, before.rulesRevision)).errorCode).to.equal('REVISION_CONFLICT');
      expect(applications).to.equal(writes);
      pacKitchen.invalidateCache();
      mods = await pacKitchen.getPacMods();
      expect(mods.siteResourceInheritance).to.deep.equal({ 'site.test': false });
      const router = new TabProxyRouter();
      router.tabs.set(7, 'www.site.test');
      const route = async host => {
        if (platform === 'firefox') {
          const resolved = await router.handle({ tabId: 7, type: 'image', url: `https://${host}/` });
          return resolved === null ? 'DIRECT' : resolved?.[0]?.host;
        }
        const context = vm.createContext({});
        vm.runInContext(cookPac('function FindProxyForURL(){return "HTTPS pac.test:443";}', mods), context);
        return context.FindProxyForURL(`https://${host}/`, host);
      };
      expect(await route('fresh.test')).to.equal('DIRECT');
      expect(await route('saved.test')).to.equal('DIRECT');
      expect(await route('cdn.site.test')).to.contain('b.test');
      expect(await route('www.site.test')).to.contain('b.test');
      await tracker.observe({ tabId: 7, url: 'https://late.test/x', type: 'script' });
      await tracker.flush();
      mods = await pacKitchen.getPacMods();
      expect(await route('late.test')).to.equal('DIRECT');
      expect((await choose(a, mods.rulesRevision, 'www.site.test')).success).to.equal(true);
      mods = await pacKitchen.getPacMods();
      expect(mods.siteResourceInheritance).to.deep.equal({ 'site.test': false });
      expect(await route('late.test')).to.equal('DIRECT');
      expect(await route('www.site.test')).to.contain('a.test');
      expect(await route('cdn.site.test')).to.contain('b.test');
      expect((await inheritance(true, mods.rulesRevision)).success).to.equal(true);
      mods = await pacKitchen.getPacMods();
      expect(mods.siteResourceInheritance).to.deep.equal({});
      expect(await route('late.test')).to.contain('a.test');
      expect(await route('saved.test')).to.contain('a.test');
      expect(await route('manual.test')).to.contain('a.test');
      expect(await route('direct.test')).to.equal('DIRECT');
    });
  }

  for (const platform of ['chrome', 'firefox']) {
    it(`${platform}: changes root/current mainHost, preserves manual siblings and inherits late resources`, async () => {
      proxyBackend.platform = platform;
      const { a, b } = await seed();
      await pacKitchen.updatePacMods(current => ({ ...current, defaultProxyId: a, ifUseLocalTor: true,
        exceptions: { 'manual.site.test': true, 'direct.site.test': false, '*.assets.site.test': true },
        domainProxyIds: { 'manual.site.test': 'builtin:tor', '*.assets.site.test': a } }), { source: 'manual' });
      await pacKitchen.updatePacMods(current => ({ ...current, ifUseLocalTor: false }));
      await tracker.observe({ tabId: 7, url: 'https://img.assets.site.test/x', type: 'image' });
      expect((await choose(b)).success).to.equal(true);
      let mods = await pacKitchen.getPacMods();
      expect(mods.defaultProxyId).to.equal(a);
      expect(mods.domainProxyIds).to.include({ 'site.test': b, 'www.site.test': b,
        'manual.site.test': 'builtin:tor', '*.assets.site.test': a });
      expect(mods.exceptions['direct.site.test']).to.equal(false);
      expect(mods.exceptions).not.to.have.property('img.assets.site.test');
      await tracker.observe({ tabId: 7, url: 'https://late.test/x', type: 'image' });
      await tracker.flush();
      mods = await pacKitchen.getPacMods();
      if (platform === 'chrome') expect(mods.domainProxyIds['late.test']).to.equal(b);
      else {
        expect(mods.exceptions).not.to.have.property('late.test');
        const router = new TabProxyRouter();
        router.tabs.set(7, 'www.site.test');
        const request = host => router.handle({ tabId: 7, type: 'image', url: `https://${host}/x` });
        expect((await request('late.test'))[0].host).to.equal('b.test');
        expect(await request('direct.site.test')).to.equal(null);
        expect((await request('img.assets.site.test'))[0].host).to.equal('a.test');
        expect((await request('manual.site.test'))[0].host).not.to.match(/a\.test|b\.test/);
      }
      // A manually assigned resource can subsequently become the chosen page.
      tab.url = 'https://manual.site.test/';
      expect((await choose(b)).success).to.equal(true);
      expect((await pacKitchen.getPacMods()).domainProxyIds['manual.site.test']).to.equal(b);
    });
  }
});
