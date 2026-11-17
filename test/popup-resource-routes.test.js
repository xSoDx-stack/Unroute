import { expect } from 'chai';
import { SiteResources } from '../src/common/core/site-resources.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';

describe('Popup resource route snapshot', () => {
  let originalGet, originalPlatform, originalChrome;
  const mods = { ifNoMods: false, ifMindExceptions: true, filteredCustomsString: 'HTTPS pool.test:443', rulesRevision: 12,
    exceptions: { '*.cdn.test': true, 'direct.test': false, 'legacy.test': true, 'site.test': true },
    domainProxyIds: { '*.cdn.test': 'custom:a', 'site.test': 'custom:b' },
    ruleMeta: { 'exception:img.cdn.test': { source: 'auto', site: 'site.test' } } };
  beforeEach(() => {
    originalGet = pacKitchen.getPacMods;
    originalPlatform = proxyBackend.platform;
    originalChrome = globalThis.chrome;
    globalThis.chrome = { tabs: { get: (id, cb) => cb({ id, url: 'https://www.site.test/' }) } };
    pacKitchen.getPacMods = async () => mods;
  });
  afterEach(() => {
    pacKitchen.getPacMods = originalGet;
    proxyBackend.platform = originalPlatform;
    globalThis.chrome = originalChrome;
  });
  function tracker(hosts) {
    const value = new SiteResources(); value.ready = Promise.resolve();
    value.tabs.set(7, { root: 'site.test', mainHost: 'www.site.test', hosts: new Set(hosts), needsReload: false });
    return value;
  }
  it('returns only bounded observed hosts, their configured assignment and the matching revision', async () => {
    proxyBackend.platform = 'chromium';
    const summary = await tracker(['img.cdn.test', 'direct.test', 'legacy.test', 'unknown.test']).summary(7, 'www.site.test');
    expect(summary.rulesRevision).to.equal(12);
    expect(summary.routes).to.deep.equal({
      'direct.test': { mode: 'direct', proxyId: null, origin: 'manual', ruleKey: 'direct.test', canResetExact: true },
      'img.cdn.test': { mode: 'proxy', proxyId: 'custom:a', origin: 'manual', ruleKey: '*.cdn.test', canResetExact: false },
      'legacy.test': { mode: 'proxy', proxyId: null, origin: 'manual', ruleKey: 'legacy.test', canResetExact: true },
      'unknown.test': { mode: 'pac', proxyId: null, origin: 'pac', ruleKey: null, canResetExact: false },
    });
    expect(summary.routes).not.to.have.property('site.test');
  });
  it('labels plain parent suffix inheritance as site intent, not PAC or a manual resource pin', async () => {
    proxyBackend.platform = 'chromium';
    const summary = await tracker(['img.site.test', 'site.test', 'www.site.test']).summary(7, 'www.site.test');
    expect(summary.routes['img.site.test']).to.include({ origin: 'site', ruleKey: 'site.test', canResetExact: false });
    expect(summary.routes['site.test']).to.include({ origin: 'main', canResetExact: false });
    expect(summary.routes['www.site.test']).to.include({ origin: 'main', canResetExact: false });
  });

  it('preserves foreign site-controlled resource rules in Firefox in both inheritance modes', async () => {
    proxyBackend.platform = 'firefox';
    const previousMeta = mods.ruleMeta, previousPolicy = mods.siteResourceInheritance;
    mods.ruleMeta = { 'exception:*.cdn.test': { source: 'site', site: 'other.test' },
      'proxy:*.cdn.test': { source: 'site', site: 'other.test' } };
    try {
      for (const inherit of [true, false]) {
        mods.siteResourceInheritance = inherit ? {} : { 'site.test': false };
        const summary = await tracker(['img.cdn.test']).summary(7, 'www.site.test');
        expect(summary.routes['img.cdn.test']).to.include({ mode: 'proxy', proxyId: 'custom:a', origin: 'manual', ruleKey: '*.cdn.test' });
      }
    } finally { mods.ruleMeta = previousMeta; mods.siteResourceInheritance = previousPolicy; }
  });
  it('uses Firefox tab inheritance for automatic resources, but keeps manual domain choices', async () => {
    proxyBackend.platform = 'firefox';
    const previous = mods.ruleMeta;
    mods.ruleMeta = { 'exception:*.cdn.test': { source: 'auto', site: 'other.test' } };
    try {
      let summary = await tracker(['img.cdn.test', 'direct.test', 'legacy.test']).summary(7, 'www.site.test');
      expect(summary.routes['img.cdn.test']).to.deep.equal({ mode: 'proxy', proxyId: 'custom:b', origin: 'site', ruleKey: '*.cdn.test', canResetExact: false });
      expect(summary.routes['direct.test']).to.deep.equal({ mode: 'direct', proxyId: null, origin: 'manual', ruleKey: 'direct.test', canResetExact: true });
      expect(summary.routes['legacy.test']).to.deep.equal({ mode: 'proxy', proxyId: null, origin: 'manual', ruleKey: 'legacy.test', canResetExact: true });
      mods.ruleMeta['proxy:*.cdn.test'] = { source: 'manual' };
      summary = await tracker(['img.cdn.test']).summary(7, 'www.site.test');
      expect(summary.routes['img.cdn.test'].proxyId).to.equal('custom:a');
    } finally { mods.ruleMeta = previous; }
  });
});
