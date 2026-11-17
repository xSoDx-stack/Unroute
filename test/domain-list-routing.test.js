import { expect } from 'chai';
import vm from 'node:vm';
import { TabProxyRouter } from '../src/common/core/tab-proxy-router.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';
import { cookPac } from '../src/common/core/pac-script.js';
import { matchResourceRule, describeResourceRoute } from '../src/common/core/resource-routing.js';

const lists = () => [
  { id: 'upper', enabled: true, proxyId: 'a', domains: ['*.example.com', 'cdn.test'] },
  { id: 'lower', enabled: true, proxyId: 'b', domains: ['sub.example.com', 'cdn.test'] },
];
const fixture = () => ({ ifMindExceptions: true, ifProxyOrDie: true, ifUsePacScriptProxies: true,
  exceptions: {}, domainProxyIds: {}, proxyRoutes: { a: 'HTTPS a.test:443', b: 'HTTPS b.test:443' }, domainLists: lists() });
function pac(mods, host) {
  const ctx = vm.createContext({});
  vm.runInContext(cookPac('function FindProxyForURL(){return "HTTPS native.test:443";}', mods), ctx);
  return ctx.FindProxyForURL(`https://${host}/`, host);
}
describe('Independent domain-list routing', () => {
  it('preserves list-only and PAC-only modifiers even without the default safety wrapper', () => {
    for (const extra of [{ domainLists: lists() }, { pacBypassDomains: ['cdn.test'] }]) {
      const [error, mods] = createPacModifiers({ ifProxyOrDie: false, ...extra });
      expect(error).to.equal(null);
      expect(mods.ifNoMods).to.equal(false);
      for (const key of Object.keys(extra)) expect(mods[key]).to.deep.equal(extra[key]);
    }
  });
  it('routes a list profile in Firefox without requiring the legacy proxy pool', async () => {
    const saved = { chrome: globalThis.chrome, get: pacKitchen.getPacMods, settings: proxyBackend.getSettings };
    try {
      pacKitchen.getPacMods = async () => fixture();
      proxyBackend.getSettings = async () => ({ levelOfControl: 'controlled_by_this_extension', value: { proxyType: 'autoConfig' } });
      globalThis.chrome = { runtime: {}, tabs: { get: (_, cb) => cb({ url: 'https://example.com/' }) } };
      const router = new TabProxyRouter();
      expect(await router.handle({ url: 'https://example.com/', tabId: 1, type: 'main_frame' })).to.deep.equal([{ type: 'https', host: 'a.test', port: 443 }]);
      expect(await router.handle({ url: 'https://new.test/', tabId: 1, type: 'image' })).to.deep.equal([{ type: 'https', host: 'a.test', port: 443 }]);
    } finally {
      globalThis.chrome = saved.chrome;
      pacKitchen.getPacMods = saved.get;
      proxyBackend.getSettings = saved.settings;
    }
  });
  it('keeps explicit DIRECT and PAC above lists and resets only exact manual controls', () => {
    for (const mode of ['direct', 'pac']) {
      const mods = { ...fixture(), ...(mode === 'direct' ? { exceptions: { 'cdn.test': false } } : { pacBypassDomains: ['cdn.test'] }) };
      expect(pac(mods, 'cdn.test')).to.equal(mode === 'direct' ? 'DIRECT' : 'HTTPS native.test:443');
      expect(describeResourceRoute(mods, 'cdn.test', 'example.com', true)).to.include({ mode, canResetExact: true, origin: 'manual' });
      const reset = { ...mods, exceptions: {}, pacBypassDomains: [] };
      expect(pac(reset, 'cdn.test')).to.equal('HTTPS a.test:443');
      expect(describeResourceRoute(reset, 'cdn.test', 'example.com', true)).to.include({ origin: 'list', canResetExact: false });
    }
  });
  it('preserves list ordering, skips disabled lists, and fails closed for an unavailable winner', () => {
    const mods = fixture();
    expect(pac({ ...mods, domainLists: [...mods.domainLists].reverse() }, 'sub.example.com')).to.equal('HTTPS b.test:443');
    expect(pac({ ...mods, domainLists: mods.domainLists.map((l, i) => i ? l : { ...l, enabled: false }) }, 'sub.example.com')).to.equal('HTTPS b.test:443');
    for (const ifProxyOrDie of [false, true]) {
      expect(pac({ ...mods, ifProxyOrDie, proxyRoutes: { b: 'HTTPS b.test:443' } }, 'cdn.test')).to.equal('PROXY 127.0.0.1:9');
    }
  });
  it('fails closed for unavailable identities that are inherited object property names', () => {
    const mods = { ...fixture(), domainLists: [{ ...lists()[0], proxyId: 'constructor' }] };
    expect(pac(mods, 'cdn.test')).to.equal('PROXY 127.0.0.1:9');
  });
  it('uses tab policy for a plain parent-list suffix but keeps independent listed CDNs', () => {
    const mods = { ...fixture(), domainLists: [{ ...lists()[0], domains: ['example.com', 'cdn.test'] }], siteResourceInheritance: { 'example.com': false } };
    expect(describeResourceRoute(mods, 'sub.example.com', 'www.example.com', true)).to.include({ mode: 'direct', origin: 'site' });
    expect(describeResourceRoute(mods, 'cdn.test', 'www.example.com', true)).to.include({ mode: 'proxy', proxyId: 'a', origin: 'list' });
    expect(describeResourceRoute({ ...mods, siteResourceInheritance: {} }, 'new.test', 'www.example.com', true)).to.include({ mode: 'proxy', proxyId: 'a', origin: 'site' });
  });
  it('does not let list discovery steal auto DIRECT from its own parent, or steal a listed external CDN', () => {
    const mods = { ...fixture(), domainLists: [{ ...lists()[0], domains: ['example.com', 'cdn.test'] }],
      exceptions: { 'sub.example.com': false, 'cdn.test': false },
      ruleMeta: { 'exception:sub.example.com': { source: 'auto', site: 'example.com' }, 'exception:cdn.test': { source: 'auto', site: 'example.com' } } };
    expect(pac(mods, 'sub.example.com')).to.equal('DIRECT');
    expect(pac(mods, 'cdn.test')).to.equal('HTTPS a.test:443');
  });
  it('uses the current parent-list profile rather than a stale materialized resource assignment', () => {
    const old = { ...fixture(), domainLists: [{ ...lists()[0], domains: ['example.com'] }],
      exceptions: { 'asset.example.com': true }, domainProxyIds: { 'asset.example.com': 'a' },
      ruleMeta: { 'exception:asset.example.com': { source: 'auto', site: 'example.com' },
        'proxy:asset.example.com': { source: 'auto', site: 'example.com' } } };
    expect(pac(old, 'asset.example.com')).to.equal('HTTPS a.test:443');
    const next = { ...old, domainLists: old.domainLists.map(list => ({ ...list, proxyId: 'b' })) };
    expect(pac(next, 'asset.example.com')).to.equal('HTTPS b.test:443');
    expect(describeResourceRoute(next, 'asset.example.com', 'www.example.com', false)).to.include({ mode: 'proxy', proxyId: 'b' });
    expect(pac({ ...next, proxyRoutes: { a: 'HTTPS a.test:443' } }, 'asset.example.com')).to.equal('PROXY 127.0.0.1:9');
  });

  it('resolves a cross-site automatic CDN through the current parent list without delayed reconciliation', () => {
    const old = { ...fixture(), domainLists: [{ ...lists()[0], domains: ['example.com'] }],
      exceptions: { 'asset.cdn.test': true }, domainProxyIds: { 'asset.cdn.test': 'a' },
      ruleMeta: { 'exception:asset.cdn.test': { source: 'auto', site: 'example.com' },
        'proxy:asset.cdn.test': { source: 'auto', site: 'example.com' } } };
    const next = { ...old, domainLists: old.domainLists.map(list => ({ ...list, proxyId: 'b' })) };
    expect(pac(next, 'asset.cdn.test')).to.equal('HTTPS b.test:443');
    expect(describeResourceRoute(next, 'asset.cdn.test', 'www.example.com', false)).to.include({ mode: 'proxy', proxyId: 'b' });
    expect(pac({ ...next, proxyRoutes: { a: 'HTTPS a.test:443' } }, 'asset.cdn.test')).to.equal('PROXY 127.0.0.1:9');
    expect(pac({ ...next, exceptions: { ...next.exceptions, 'example.com': false } }, 'asset.cdn.test')).to.equal('DIRECT');
    expect(pac({ ...next, pacBypassDomains: ['example.com'] }, 'asset.cdn.test')).to.equal('HTTPS native.test:443');
  });

  it('drops stale positive automatic copies when their last parent list is disabled or deleted', () => {
    const old = { ...fixture(), domainLists: [{ ...lists()[0], domains: ['example.com'] }],
      exceptions: { 'asset.cdn.test': true }, domainProxyIds: { 'asset.cdn.test': 'a' },
      ruleMeta: { 'exception:asset.cdn.test': { source: 'auto', site: 'example.com',
        inheritedListId: 'meta', inheritedMainHost: 'example.com' },
        'proxy:asset.cdn.test': { source: 'auto', site: 'example.com' } } };
    for (const domainLists of [[{ ...old.domainLists[0], enabled: false }], []]) {
      const next = { ...old, domainLists };
      expect(pac(next, 'asset.cdn.test')).to.equal('HTTPS native.test:443');
      expect(describeResourceRoute(next, 'asset.cdn.test', 'www.example.com', false)).to.include({ mode: 'pac', proxyId: null });
    }
  });

  it('honors global gates before lists and PAC bypasses', () => {
    const mods = fixture();
    expect(pac({ ...mods, ifMindExceptions: false }, 'cdn.test')).to.equal('HTTPS native.test:443');
    expect(pac({ ...mods, ifProxyHttpsUrlsOnly: true }, 'cdn.test')).to.equal('HTTPS a.test:443');
    const ctx = vm.createContext({});
    vm.runInContext(cookPac('function FindProxyForURL(){return "HTTPS native.test:443";}', { ...mods, ifProxyHttpsUrlsOnly: true }), ctx);
    expect(ctx.FindProxyForURL('http://cdn.test/', 'cdn.test')).to.equal('DIRECT');
  });
  it('keeps Firefox parity for disabled/unavailable lists, manual routes, PAC and policy', async () => {
    const saved = { chrome: globalThis.chrome, get: pacKitchen.getPacMods, settings: proxyBackend.getSettings };
    let mods;
    try {
      pacKitchen.getPacMods = async () => mods;
      proxyBackend.getSettings = async () => ({ levelOfControl: 'controlled_by_this_extension', value: { proxyType: 'autoConfig' } });
      globalThis.chrome = { runtime: {}, tabs: { get: (_, cb) => cb({ url: 'https://example.com/' }) } };
      const router = new TabProxyRouter();
      router.tabs.set(1, 'example.com');
      const request = (host = 'cdn.test', scheme = 'https') => router.handle({ url: `${scheme}://${host}/`, tabId: 1, type: 'image' });
      mods = { ...fixture(), exceptions: { 'cdn.test': true }, domainProxyIds: { 'cdn.test': 'b' } };
      expect((await request())[0].host).to.equal('b.test');
      mods = { ...fixture(), exceptions: { 'cdn.test': false } };
      expect(await request()).to.equal(null);
      mods = { ...fixture(), pacBypassDomains: ['cdn.test'] };
      expect(await request()).to.equal(undefined);
      mods = { ...fixture(), pacBypassDomains: ['example.com'] };
      expect(await request('unknown.test')).to.equal(undefined);
      mods = { ...fixture(), proxyRoutes: { b: 'HTTPS b.test:443' }, ifProxyOrDie: false };
      expect(await request()).to.deep.equal([{ type: 'http', host: '127.0.0.1', port: 9 }]);
      mods = { ...fixture(), domainLists: lists().map((list, i) => i ? list : { ...list, enabled: false }) };
      expect((await request())[0].host).to.equal('b.test');
      mods = { ...fixture(), siteResourceInheritance: { 'example.com': false } };
      expect(await request('unknown.test')).to.equal(null);
      expect((await request())[0].host).to.equal('a.test');
      mods = { ...fixture(), ifProxyHttpsUrlsOnly: true };
      expect(await request('cdn.test', 'http')).to.equal(null);
      mods = { ...fixture(), ifMindWhitelist: true, whitelist: [] };
      expect(await request()).to.equal(null);
    } finally {
      globalThis.chrome = saved.chrome;
      pacKitchen.getPacMods = saved.get;
      proxyBackend.getSettings = saved.settings;
    }
  });
  it('uses the first matching list even above a deeper exact rule in PAC and snapshots', () => {
    const mods = fixture();
    expect(pac(mods, 'sub.example.com')).to.equal('HTTPS a.test:443');
    expect(matchResourceRule(mods, 'sub.example.com', 'sub.example.com').proxyId).to.equal('a');
    expect(describeResourceRoute(mods, 'cdn.test', 'example.com', true)).to.include({ mode: 'proxy', proxyId: 'a', origin: 'list', canResetExact: false });
  });
});
