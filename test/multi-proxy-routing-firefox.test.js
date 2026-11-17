import { expect } from 'chai';
import { TabProxyRouter } from '../src/common/core/tab-proxy-router.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';

const a = { type: 'https', host: 'a.test', port: 443 };
const b = { type: 'https', host: 'b.test', port: 443 };
const dead = { type: 'http', host: '127.0.0.1', port: 9 };
describe('Multi-proxy Firefox runtime', () => {
  let saved, mods, router;
  const req = (url, type = 'image', tabId = 1) => ({ url: `https://${url}/`, type, tabId });
  beforeEach(() => {
    saved = { chrome: globalThis.chrome, get: pacKitchen.getPacMods, settings: proxyBackend.getSettings };
    mods = { ifMindExceptions: true, ifProxyOrDie: true,
      exceptions: { 'page.test': true, 'other.test': true, 'direct.test': false },
      domainProxyIds: { 'page.test': 'custom:a', 'other.test': 'custom:b' },
      proxyRoutes: { 'custom:a': 'HTTPS a.test:443', 'custom:b': 'HTTPS b.test:443' } };
    pacKitchen.getPacMods = async () => mods;
    proxyBackend.getSettings = async () => ({ levelOfControl: 'controlled_by_this_extension', value: { proxyType: 'autoConfig' } });
    globalThis.chrome = { runtime: {}, tabs: { get: (_, cb) => cb({ url: 'https://page.test/' }) } };
    router = new TabProxyRouter();
  });
  afterEach(() => { globalThis.chrome = saved.chrome; pacKitchen.getPacMods = saved.get; proxyBackend.getSettings = saved.settings; });
  it('inherits a single assigned tab target without requiring legacy pool', async () => {
    expect(await router.handle(req('page.test', 'main_frame'))).to.deep.equal([a]);
    expect(await router.handle(req('cdn.test'))).to.deep.equal([a]);
  });
  it('manual assigned and direct request rules beat the tab target', async () => {
    await router.handle(req('page.test', 'main_frame'));
    expect(await router.handle(req('other.test'))).to.deep.equal([b]);
    expect(await router.handle(req('direct.test'))).to.equal(null);
  });
  it('automatic CDN binding cannot hijack a different explicit tab target', async () => {
    mods.ruleMeta = { 'exception:other.test': { source: 'auto', site: 'elsewhere.test' } };
    await router.handle(req('page.test', 'main_frame'));
    expect(await router.handle(req('other.test'))).to.deep.equal([a]);
  });
  it('a separately manual proxy assignment wins even when its boolean rule originated automatically', async () => {
    mods.ruleMeta = { 'exception:other.test': { source: 'auto', site: 'elsewhere.test' },
      'proxy:other.test': { source: 'manual' } };
    await router.handle(req('page.test', 'main_frame'));
    expect(await router.handle(req('other.test'))).to.deep.equal([b]);
  });
  it('fails closed when an assigned target is missing, including with opt-in fallback', async () => {
    mods.ifProxyOrDie = false;
    delete mods.proxyRoutes['custom:a'];
    expect(await router.handle(req('page.test', 'main_frame'))).to.deep.equal([dead]);
  });
  it('allows DIRECT only for valid assigned targets with explicit opt-in', async () => {
    mods.ifProxyOrDie = false;
    expect(await router.handle(req('page.test', 'main_frame'))).to.deep.equal([a, null]);
  });
  it('fails closed on assigned resolver errors instead of using native PAC', async () => {
    mods.proxyRoutes = new Proxy({}, { get() { throw new Error('Broken route index'); } });
    expect(await router.handle(req('page.test', 'main_frame'))).to.deep.equal([dead]);
  });
  it('fails closed if settings lookup fails for a known assigned route', async () => {
    proxyBackend.getSettings = async () => { throw new Error('Settings unavailable'); };
    expect(await router.handle(req('page.test', 'main_frame'))).to.deep.equal([dead]);
  });
  it('retains native automatic Tor for unassigned onion rules', async () => {
    mods.ifUseLocalTor = true;
    mods.filteredCustomsString = 'HTTPS a.test:443';
    mods.exceptions['legacy.onion'] = true;
    expect(await router.handle(req('legacy.onion', 'main_frame'))).to.equal(undefined);
  });
  it('keeps tabless and speculative requests in native PAC', async () => {
    expect(await router.handle(req('page.test', 'image', -1))).to.equal(undefined);
    expect(await router.handle(req('page.test', 'speculative'))).to.equal(undefined);
  });
});
