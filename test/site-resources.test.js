'use strict';

import { expect } from 'chai';
import { SiteResources, resourceHost } from '../src/common/core/site-resources.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { pacSync } from '../src/common/core/pac-sync.js';
import { appState } from '../src/common/core/app-state.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { migrateSettings, recordRuleChange } from '../src/common/core/settings-schema.js';
import { encodeSettings, decodeSettings } from '../src/common/core/settings-codec.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';

describe('Whole-site resource routing', () => {
  let tracker;
  let mods;
  let updates;
  let applies;
  let original;
  let tabs;
  let session;
  let storageListener;

  beforeEach(() => {
    original = { chrome: globalThis.chrome, get: pacKitchen.getPacMods,
      update: pacKitchen.updatePacMods, apply: pacSync.reapplyCurrentPac, init: appState.ensureLocalStateInitialized,
      coordinatedApply: settingsCoordinator.apply };
    mods = { exceptions: {}, ifMindExceptions: true, filteredCustomsString: 'PROXY localhost:8080' };
    updates = 0;
    applies = 0;
    session = {};
    tabs = [{ id: 1, url: 'https://www.example.com/page', incognito: false }];
    globalThis.chrome = {
      runtime: {},
      tabs: {
        query: (_, cb) => cb(tabs),
        get: (id, cb) => cb(tabs.find((tab) => tab.id === id)),
      },
      storage: { onChanged: { addListener: fn => { storageListener = fn; } }, session: {
        get: (_, cb) => cb(session),
        set: (data, cb) => { Object.assign(session, data); cb(); },
        remove: (key, cb) => { delete session[key]; cb(); },
      } },
    };
    pacKitchen.getPacMods = async () => ({ ...mods, ifMindExceptions: mods.ifMindExceptions !== false });
    pacKitchen.updatePacMods = async (fn, context = {}) => {
      updates++;
      mods = await fn(mods);
      if (context.source === 'site' || context.source === 'auto') {
        mods.ruleMeta = { ...mods.ruleMeta };
        for (const domain of new Set([...(context.touchedDomains || []), ...Object.keys(context.siteForDomain || {})])) {
          mods.ruleMeta[`exception:${domain}`] = { source: context.source, site: context.siteForDomain?.[domain] || context.site };
        }
      }
      return mods;
    };
    pacSync.reapplyCurrentPac = async () => { applies++; };
    appState.ensureLocalStateInitialized = async () => {};
    settingsCoordinator.apply = async () => { await pacSync.reapplyCurrentPac(); return { pending: false }; };
    tracker = new SiteResources();
    tracker.schedule = () => {};
  });

  afterEach(() => {
    globalThis.chrome = original.chrome;
    pacKitchen.getPacMods = original.get;
    pacKitchen.updatePacMods = original.update;
    pacSync.reapplyCurrentPac = original.apply;
    appState.ensureLocalStateInitialized = original.init;
    settingsCoordinator.apply = original.coordinatedApply;
  });

  async function request(host, type = 'image', tabId = 1) {
    await tracker.observe({ tabId, url: `https://${host}/asset`, type });
  }

  it('exposes metadata provenance without mistaking same-profile manual pins for inheritance', async () => {
    mods.exceptions = { 'example.com': true, 'manual.test': true, '*.cdn.test': false, 'owned.test': true, 'other.test': true, 'mixed.test': true };
    mods.domainProxyIds = { 'example.com': 'a', 'manual.test': 'a', 'owned.test': 'a', 'other.test': 'a', 'mixed.test': 'a' };
    const own = { source: 'auto', site: 'example.com' };
    mods.ruleMeta = { 'exception:owned.test': own, 'exception:other.test': { source: 'auto', site: 'other.com' },
      'exception:mixed.test': own, 'proxy:mixed.test': { source: 'import' } };
    for (const host of ['example.com', 'www.example.com', 'manual.test', 'img.cdn.test', 'owned.test', 'other.test', 'mixed.test', 'unknown.test']) await request(host);
    const routes = (await tracker.summary(1, 'example.com')).routes;
    expect(routes['manual.test']).to.deep.equal({ mode: 'proxy', proxyId: 'a', origin: 'manual', ruleKey: 'manual.test', canResetExact: true });
    expect(routes['img.cdn.test']).to.include({ origin: 'manual', ruleKey: '*.cdn.test', canResetExact: false });
    expect(routes['mixed.test']).to.include({ origin: 'manual', canResetExact: true });
    expect(routes['owned.test']).to.include({ origin: 'site', canResetExact: false });
    expect(routes['other.test']).to.include({ origin: 'automatic-other', canResetExact: false });
    expect(routes['unknown.test']).to.include({ origin: 'pac', ruleKey: null, canResetExact: false });
    expect(routes['example.com']).to.include({ origin: 'main', canResetExact: false });
    expect(routes['www.example.com']).to.include({ origin: 'main', canResetExact: false });
  });

  it('resets only an exact manual resource and immediately inherits the parent in persisted raw and parsed settings', async () => {
    mods = { ...migrateSettings({ ...mods, exceptions: { 'example.com': false, 'cdn.test': true, '*.keep.test': false },
      _rulesRevision: 3 }), domainProxyIds: { 'cdn.test': 'custom:missing' } };
    await request('cdn.test');
    pacKitchen.updatePacMods = async (fn, context) => {
      const next = await fn(mods);
      mods = migrateSettings(decodeSettings(encodeSettings(recordRuleChange(mods, next, context))));
      return createPacModifiers(mods)[1];
    };
    const result = await tracker.resetResourceRule(1, 'example.com', 'cdn.test', 3, 'www.example.com');
    expect(result).to.include({ count: 1, privateTab: false });
    expect(mods.exceptions).to.deep.equal({ 'example.com': false, 'cdn.test': false, '*.keep.test': false });
    expect(mods.domainProxyIds).to.deep.equal({});
    expect(mods.ruleMeta['exception:cdn.test']).to.include({ source: 'auto', site: 'example.com' });
    expect(mods.ruleMeta['exception:cdn.test'].suppressAuto).not.to.equal(true);
    expect(mods.ruleMeta['proxy:cdn.test']?.suppressAuto).not.to.equal(true);
    expect(mods._rulesRevision).to.equal(4);
    expect(createPacModifiers(mods)[1].ruleMeta['exception:cdn.test'].source).to.equal('auto');
    expect(applies).to.equal(1);
  });

  it('toggles one sparse site policy atomically, refreshes owned/late resources, and preserves manual and main routes', async () => {
    mods._rulesRevision = 3;
    mods.exceptions = { 'example.com': true, '*.example.com': true, 'owned.test': true, 'manual.test': false };
    mods.domainProxyIds = { 'example.com': 'parent', '*.example.com': 'manual', 'owned.test': 'parent' };
    mods.ruleMeta = { 'exception:owned.test': { source: 'auto', site: 'example.com' } };
    await request('owned.test');
    await request('img.example.com');
    await request('manual.test');
    await tracker.setInheritance(1, 'example.com', false, 3, 'www.example.com');
    expect(mods.siteResourceInheritance).to.deep.equal({ 'example.com': false });
    expect(mods.exceptions).to.deep.equal({ 'example.com': true, '*.example.com': true, 'owned.test': false, 'manual.test': false });
    expect(mods.domainProxyIds).to.deep.equal({ 'example.com': 'parent', '*.example.com': 'manual' });
    expect((await tracker.summary(1, 'example.com')).inheritResources).to.equal(false);
    expect((await tracker.summary(1, 'example.com')).canInheritResources).to.equal(true);
    await request('late.test');
    await tracker.flush();
    expect(mods.exceptions['late.test']).to.equal(false);
    await tracker.setInheritance(1, 'example.com', true, 3, 'www.example.com');
    expect(mods.siteResourceInheritance).to.deep.equal({});
    expect(mods.exceptions['owned.test']).to.equal(true);
    expect(mods.domainProxyIds['owned.test']).to.equal('manual');
    expect(mods.exceptions['late.test']).to.equal(true);
  });

  it('reports the saved root policy for a private subdomain without recording private resources', async () => {
    tabs[0].incognito = true;
    mods.siteResourceInheritance = { 'example.com': false };
    const summary = await tracker.summary(1, 'www.example.com');
    expect(summary).to.include({ inheritResources: false, canInheritResources: false, count: 0 });
    expect(tracker.tabs.size).to.equal(0);
    expect(updates).to.equal(0);
  });

  it('rejects malformed checkbox payloads and revalidates navigation/revision inside the write queue', async () => {
    mods._rulesRevision = 3;
    await request('cdn.test');
    const rejected = async (enabled, revision, host, domain = 'example.com') => {
      let error;
      try { await tracker.setInheritance(1, domain, enabled, revision, host); } catch (caught) { error = caught; }
      expect(error).to.be.instanceOf(Error);
      expect(mods.siteResourceInheritance).to.equal(undefined);
    };
    for (const enabled of [undefined, null, 'false', 0, 1]) await rejected(enabled, 3, 'www.example.com');
    for (const revision of [undefined, null, '3', -1]) await rejected(false, revision, 'www.example.com');
    for (const host of [undefined, null, 'example.com', 'https://www.example.com']) await rejected(false, 3, host);
    await rejected(false, 3, 'www.example.com', '*.example.com');
    expect(updates).to.equal(0);
    const update = pacKitchen.updatePacMods;
    pacKitchen.updatePacMods = async (fn, context) => {
      mods._rulesRevision = 4;
      return update(fn, context);
    };
    await rejected(false, 3, 'www.example.com');
    pacKitchen.updatePacMods = async (fn, context) => {
      tabs[0].url = 'https://other.example.com/';
      return update(fn, context);
    };
    await rejected(false, 4, 'www.example.com');
    expect(applies).to.equal(0);
  });

  it('rejects checkbox while private, rules disabled, own routing unavailable, or mods disabled', async () => {
    await request('cdn.test');
    for (const disabled of ['private', 'rules', 'own', 'mods']) {
      tabs[0].incognito = disabled === 'private';
      mods.ifMindExceptions = disabled !== 'rules';
      mods.filteredCustomsString = disabled === 'own' ? '' : 'PROXY localhost:8080';
      mods.ifNoMods = disabled === 'mods';
      let error;
      try { await tracker.setInheritance(1, 'example.com', false, 0, 'www.example.com'); } catch (caught) { error = caught; }
      expect(error).to.be.instanceOf(Error);
      expect(mods.siteResourceInheritance).to.equal(undefined);
      expect((await tracker.summary(1, 'example.com')).canInheritResources).to.equal(false);
    }
  });

  it('inherits assigned built-in resources even when the legacy custom pool is empty', async () => {
    mods.filteredCustomsString = '';
    mods.exceptions['example.com'] = true;
    mods.domainProxyIds = { 'example.com': 'builtin:tor' };
    mods.proxyRoutes = { 'builtin:tor': 'SOCKS5 localhost:9050' };
    await request('video.cdn.test');
    await tracker.flush();
    expect(mods.exceptions['video.cdn.test']).to.equal(true);
    expect(mods.domainProxyIds['video.cdn.test']).to.equal('builtin:tor');
    expect((await tracker.summary(1, 'example.com')).routing).to.equal('domains');
  });

  it('pins new site/resources to the selected target and clears IDs on DIRECT/reset', async () => {
    mods.defaultProxyId = 'custom:a';
    mods.proxyRoutes = { 'custom:a': 'HTTPS a.test:443', 'custom:b': 'HTTPS b.test:443' };
    await request('video.cdn.test');
    await tracker.setMode(1, 'example.com', true);
    expect(mods.domainProxyIds).to.include({ 'example.com': 'custom:a', 'video.cdn.test': 'custom:a' });
    mods.defaultProxyId = 'custom:b';
    await tracker.setMode(1, 'example.com', true);
    expect(mods.domainProxyIds['example.com']).to.equal('custom:a');
    await tracker.setMode(1, 'example.com', true, 'custom:b');
    expect(mods.domainProxyIds['example.com']).to.equal('custom:b');
    await tracker.setMode(1, 'example.com', false);
    expect(mods.domainProxyIds).to.deep.equal({});
    await tracker.setMode(1, 'example.com', null);
    expect(mods.domainProxyIds).to.deep.equal({});
  });

  it('persists inherited IDs together with auto resource rules', async () => {
    mods.exceptions['example.com'] = true;
    mods.domainProxyIds = { 'example.com': 'custom:a' };
    await request('video.cdn.test');
    await tracker.flush();
    expect(mods.exceptions['video.cdn.test']).to.equal(true);
    expect(mods.domainProxyIds['video.cdn.test']).to.equal('custom:a');
  });

  it('protects competing manual resource bindings from site switches and reset', async () => {
    mods.exceptions['manual.cdn.test'] = true;
    mods.domainProxyIds = { 'manual.cdn.test': 'custom:b' };
    mods.ruleMeta = { 'exception:manual.cdn.test': { source: 'manual' } };
    mods.proxyRoutes = { 'custom:a': 'HTTPS a.test:443' };
    await request('manual.cdn.test');
    await tracker.setMode(1, 'example.com', true, 'custom:a');
    expect(mods.domainProxyIds['manual.cdn.test']).to.equal('custom:b');
    await tracker.setMode(1, 'example.com', false);
    expect(mods.exceptions['manual.cdn.test']).to.equal(true);
    await tracker.setMode(1, 'example.com', null);
    expect(mods.domainProxyIds['manual.cdn.test']).to.equal('custom:b');
  });

  it('checks expectedRevision against the serialized current snapshot and never applies stale changes', async () => {
    mods._rulesRevision = 3;
    const update = pacKitchen.updatePacMods;
    pacKitchen.updatePacMods = async (fn, context) => {
      mods = { ...mods, _rulesRevision: 4 };
      return update(fn, context);
    };
    let error;
    try { await tracker.setMode(1, 'example.com', false, undefined, 3); } catch (caught) { error = caught; }
    expect(error?.code).to.equal('REVISION_CONFLICT');
    expect(mods.exceptions).to.deep.equal({});
    expect(applies).to.equal(0);
    expect(tracker.needsApply).to.equal(false);
    await tracker.setMode(1, 'example.com', false, undefined, 4);
    expect(mods.exceptions['example.com']).to.equal(false);
    expect(applies).to.equal(1);
  });

  it('does not substitute default or an existing ID for an explicitly empty proxy selection', async () => {
    mods.defaultProxyId = 'custom:a';
    mods.proxyRoutes = { 'custom:a': 'HTTPS a.test:443' };
    for (const proxyId of ['', null]) {
      let error;
      try { await tracker.setMode(1, 'example.com', true, proxyId); } catch (caught) { error = caught; }
      expect(error?.code).to.equal('PROXY_TARGET_UNAVAILABLE');
      expect(mods.exceptions).to.deep.equal({});
    }
    expect(applies).to.equal(0);
  });

  it('rejects a new unavailable assignment without saving it', async () => {
    mods.proxyRoutes = {};
    let error;
    try { await tracker.setMode(1, 'example.com', true, 'custom:missing'); } catch (caught) { error = caught; }
    expect(error?.code).to.equal('PROXY_TARGET_UNAVAILABLE');
    expect(mods.exceptions).to.deep.equal({});
  });

  it('ignores profile rename/default-only storage updates', async () => {
    tracker.setup();
    await request('cdn.test');
    await tracker.flush();
    const revision = tracker.rulesRevision;
    await storageListener({ 'pac-kitchen-mods': { oldValue: mods,
      newValue: { ...mods, defaultProxyId: 'custom:a', _proxyCatalogRevision: 2,
        proxyProfiles: [{ id: 'custom:a', name: 'Renamed', endpoint: 'HTTPS a.test:443' }] } } }, 'local');
    expect(tracker.rulesRevision).to.equal(revision);
    expect(tracker.tabs.get(1).pending.size).to.equal(0);
  });

  it('collects all request types once, without reading rules or writing per request', async () => {
    for (const type of ['image', 'media', 'xmlhttprequest', 'script', 'sub_frame', 'websocket']) {
      await request('cdn.example.net', type);
    }
    expect((await tracker.summary(1, 'example.com')).hosts).to.deep.equal(['cdn.example.net']);
    expect(updates).to.equal(0);
    await tracker.flush();
    expect(updates).to.equal(0);
    expect(applies).to.equal(0);
  });

  it('does not recreate automatically added rules after undo', async () => {
    mods.exceptions = { 'example.com': true };
    mods.ruleMeta = { 'exception:cdn.test': { source: 'undo', suppressAuto: true } };
    await request('cdn.test');
    await tracker.flush();
    expect(mods.exceptions).not.to.have.property('cdn.test');
    await tracker.setMode(1, 'example.com', true);
    expect(mods.exceptions['cdn.test']).to.equal(true);
  });

  it('switches the site and owned resources while preserving legacy manual subdomains', async () => {
    await request('video.example.net', 'media');
    await request('api.example.org', 'xmlhttprequest');
    mods.exceptions = { 'sub.example.com': true, 'api.example.org': true, 'untouched.test': true };
    mods.ruleMeta = { 'exception:api.example.org': { source: 'auto', site: 'example.com' } };
    await tracker.setMode(1, 'example.com', false);
    expect(mods.exceptions).to.include({ 'example.com': false, 'www.example.com': false,
      'sub.example.com': true, 'video.example.net': false, 'api.example.org': false, 'untouched.test': true });
    await tracker.setMode(1, 'example.com', true);
    expect(mods.exceptions['video.example.net']).to.equal(true);
    expect(mods.exceptions['api.example.org']).to.equal(true);
    expect(applies).to.equal(2);
    expect((await tracker.summary(1, 'example.com')).needsReload).to.equal(true);
  });

  it('batches new hosts, inherits legacy root rules, and respects existing overrides', async () => {
    mods = { exceptions: { 'example.com': false, '*.keep.example.net': true }, filteredCustomsString: 'PROXY localhost:8080' };
    for (let i = 0; i < 20; i++) await request(`cdn${i}.example.org`);
    await request('video.keep.example.net');
    await tracker.flush();
    expect(updates).to.equal(1);
    expect(applies).to.equal(1);
    expect(mods.exceptions['cdn19.example.org']).to.equal(false);
    expect(mods.exceptions).not.to.have.property('video.keep.example.net');
    expect(mods.exceptions['*.keep.example.net']).to.equal(true);
    await tracker.flush();
    expect(applies).to.equal(1);
  });

  it('does not oscillate a shared CDN between tabs with opposite rules', async () => {
    tabs.push({ id: 2, url: 'https://other.test/' });
    mods.exceptions = { 'example.com': false, 'other.test': true };
    await request('shared.cdn.test');
    await request('shared.cdn.test', 'media', 2);
    await tracker.flush();
    expect(mods.exceptions['shared.cdn.test']).to.equal(false);
    await tracker.setMode(2, 'other.test', true);
    await request('shared.cdn.test');
    await tracker.flush();
    // A second site must not take ownership of a shared external hostname.
    expect(mods.exceptions['shared.cdn.test']).to.equal(false);
    expect(mods.exceptions['other.test']).to.equal(true);
  });

  it('keeps new requests that arrive during PAC application for the next batch', async () => {
    mods.exceptions['example.com'] = true;
    await request('first.cdn.test');
    pacSync.reapplyCurrentPac = async () => { await request('late.cdn.test'); };
    await tracker.flush();
    expect(mods.exceptions).not.to.have.property('late.cdn.test');
    await tracker.flush();
    expect(mods.exceptions['late.cdn.test']).to.equal(true);
  });

  it('preserves resources arriving while an explicit switch is being saved', async () => {
    await request('first.cdn.test');
    pacKitchen.updatePacMods = async (fn) => {
      mods = await fn(mods);
      await request('late.cdn.test');
      return mods;
    };
    await tracker.setMode(1, 'example.com', false);
    expect(tracker.tabs.get(1).pending.has('late.cdn.test')).to.equal(true);
    await tracker.flush();
    expect(mods.exceptions['late.cdn.test']).to.equal(false);
  });

  it('retries saved rules after PAC failure and a worker restart', async () => {
    await request('video.cdn.test');
    pacSync.reapplyCurrentPac = async () => { throw new Error('Temporary PAC failure'); };
    let error;
    try { await tracker.setMode(1, 'example.com', true); } catch (caught) { error = caught; }
    expect(error.message).to.equal('Temporary PAC failure');
    expect(session['site-resource-tabs'].needsApply).to.equal(true);
    const restored = new SiteResources();
    restored.schedule = () => {};
    await restored.init();
    pacSync.reapplyCurrentPac = async () => { applies++; };
    await restored.flush();
    expect(applies).to.equal(1);
    expect(mods.exceptions['video.cdn.test']).to.equal(true);
    expect(session['site-resource-tabs'].needsApply).to.equal(false);
  });

  it('retains the known hosts across reloads but drops them when leaving the site', async () => {
    await request('video.cdn.test');
    await tracker.setMode(1, 'example.com', false);
    await request('www.example.com', 'main_frame');
    expect((await tracker.summary(1, 'example.com')).needsReload).to.equal(false);
    expect((await tracker.summary(1, 'example.com')).hosts).to.include('video.cdn.test');
    await request('unrelated.test', 'main_frame');
    expect(await tracker.summary(1, 'example.com')).to.equal(null);
    expect((await tracker.summary(1, 'unrelated.test')).hosts).not.to.include('video.cdn.test');
  });

  it('restores session snapshots only for still-open tabs on the same site', async () => {
    await request('video.cdn.test');
    await tracker.flush();
    const restored = new SiteResources();
    restored.schedule = () => {};
    expect((await restored.summary(1, 'example.com')).hosts).to.include('video.cdn.test');
    tabs[0].url = 'https://elsewhere.test/';
    const navigated = new SiteResources();
    expect(await navigated.summary(1, 'example.com')).to.equal(null);
  });

  it('does not capture private resources or local/service addresses', async () => {
    await tracker.observe({ tabId: 1, incognito: true, type: 'image', url: 'https://private.test/x' });
    await tracker.init();
    expect((await tracker.summary(1, 'example.com')).count).to.equal(0);
    for (const url of ['file:///secret', 'chrome-extension://abc/page', 'http://localhost/x',
      'http://127.0.0.1/x', 'http://192.168.1.1/x', 'http://[::1]/', 'https://device.local/x']) {
      expect(resourceHost(url)).to.equal('');
    }
    expect(resourceHost('wss://cdn.example.net/socket')).to.equal('cdn.example.net');
  });

  it('bounds stored hosts and rejects a click after the tab navigates', async () => {
    for (let i = 0; i < 310; i++) await request(`cdn${i}.example.net`);
    expect((await tracker.summary(1, 'example.com')).count).to.equal(300);
    expect((await tracker.summary(1, 'example.com')).limited).to.equal(true);
    tabs[0].url = 'https://new-site.test/';
    let error;
    try { await tracker.setMode(1, 'example.com', false); } catch (caught) { error = caught; }
    expect(error).to.be.instanceOf(Error);
    expect(updates).to.equal(0);
  });

  it('leaves resources to standard PAC when no own proxy is configured', async () => {
    mods.filteredCustomsString = '';
    mods.exceptions['example.com'] = true;
    await request('video.cdn.test');
    await tracker.flush();
    expect(updates).to.equal(0);
    await tracker.setMode(1, 'example.com', false);
    expect(mods.exceptions).not.to.have.property('video.cdn.test');
    expect((await tracker.summary(1, 'example.com')).routing).to.equal('domain');
  });

  it('never copies resource rules in Firefox even with an own proxy', async () => {
    const platform = proxyBackend.platform;
    proxyBackend.platform = 'firefox';
    try {
      mods.exceptions['example.com'] = true;
      await request('video.cdn.test');
      await tracker.flush();
      expect(updates).to.equal(0);
      await tracker.setMode(1, 'example.com', false);
      expect(mods.exceptions).not.to.have.property('video.cdn.test');
      expect((await tracker.summary(1, 'example.com')).routing).to.equal('tab');
    } finally { proxyBackend.platform = platform; }
  });

  it('resets rules of the known site/resources and leaves unrelated rules untouched', async () => {
    await request('video.cdn.test');
    await tracker.setMode(1, 'example.com', true);
    mods.exceptions['keep.test'] = false;
    await tracker.setMode(1, 'example.com', null);
    expect(mods.exceptions).to.deep.equal({ 'keep.test': false });
    await tracker.clear();
    expect(tracker.tabs.size).to.equal(0);
    expect(session).not.to.have.property('site-resource-tabs');
  });

  it('reconsiders resources collected before the main domain was added in the editor', async () => {
    tracker.setup();
    await request('video.cdn.test');
    await tracker.flush();
    mods.exceptions['example.com'] = false;
    await storageListener({ 'pac-kitchen-mods': { newValue: mods } }, 'local');
    await tracker.flush();
    expect(mods.exceptions['video.cdn.test']).to.equal(false);
    const appliesAfterRule = applies;
    await tracker.reconsider();
    await tracker.flush();
    expect(applies).to.equal(appliesAfterRule);
  });

  it('reconsiders resources after own proxies are enabled and preserves existing overrides', async () => {
    mods.filteredCustomsString = '';
    mods.exceptions = { 'example.com': true, 'keep.cdn.test': false };
    await request('video.cdn.test');
    await request('keep.cdn.test');
    await tracker.flush();
    expect(mods.exceptions).not.to.have.property('video.cdn.test');
    mods.filteredCustomsString = 'PROXY localhost:8080';
    await tracker.reconsider();
    await tracker.flush();
    expect(mods.exceptions['video.cdn.test']).to.equal(true);
    expect(mods.exceptions['keep.cdn.test']).to.equal(false);
  });

  it('restores reevaluation work after the background context restarts', async () => {
    await request('video.cdn.test');
    await tracker.flush();
    mods.exceptions['example.com'] = true;
    const restored = new SiteResources();
    restored.schedule = () => {};
    await restored.init();
    await restored.flush();
    expect(mods.exceptions['video.cdn.test']).to.equal(true);
  });

  it('does not inherit rules if own proxies are disabled during initialization', async () => {
    mods.exceptions['example.com'] = true;
    await request('video.cdn.test');
    appState.ensureLocalStateInitialized = async () => { mods.filteredCustomsString = ''; };
    await tracker.flush();
    expect(mods.exceptions).not.to.have.property('video.cdn.test');
    expect(applies).to.equal(0);
  });

  it('retains reevaluation arriving while a PAC batch is being applied', async () => {
    mods.exceptions['example.com'] = true;
    await request('video.cdn.test');
    pacSync.reapplyCurrentPac = async () => { await tracker.reconsider(); };
    await tracker.flush();
    expect(tracker.tabs.get(1).pending.has('video.cdn.test')).to.equal(true);
    await tracker.flush();
    expect(tracker.tabs.get(1).pending.size).to.equal(0);
  });
});
