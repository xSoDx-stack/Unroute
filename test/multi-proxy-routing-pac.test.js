import { expect } from 'chai';
import vm from 'node:vm';
import { cookPac } from '../src/common/core/pac-script.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';
import { reconcileProxyProfiles } from '../src/common/core/proxy-profiles.js';

const base = 'function FindProxyForURL(){ return "HTTPS public.test:443; DIRECT"; }';
const fixture = () => ({ ifMindExceptions: true, ifProxyOrDie: true, ifUsePacScriptProxies: true,
  filteredCustomsString: 'HTTPS a.test:443; HTTPS b.test:443',
  exceptions: { 'example.test': true, '*.sub.example.test': true, 'legacy.test': true },
  domainProxyIds: { 'example.test': 'custom:a', '*.sub.example.test': 'custom:b' },
  proxyRoutes: { 'custom:a': 'HTTPS a.test:443', 'custom:b': 'HTTPS b.test:443' } });
function route(mods, host, scheme = 'https') {
  const context = vm.createContext({});
  vm.runInContext(cookPac(base, mods), context);
  return context.FindProxyForURL(`${scheme}://${host}/`, host);
}
describe('Multi-proxy Chromium PAC runtime', () => {
  it('canonicalizes lowercase DIRECT before applying the configured replacement', () => {
    const context = vm.createContext({});
    vm.runInContext(cookPac('function FindProxyForURL(){ return "direct"; }', {
      ifUsePacScriptProxies: true, replaceDirectWith: 'HTTPS replacement.test:443',
    }), context);
    expect(context.FindProxyForURL('https://example.test/', 'example.test')).to.equal('HTTPS replacement.test:443');
  });

  it('recooks a previous PAC whose line endings were converted to CRLF', () => {
    const once = cookPac(base, fixture());
    expect(cookPac(once.replace(/\r?\n/g, '\r\n'), fixture())).to.equal(once);
  });
  it('omits the wrapper for empty rules but retains active inheritance policy', () => {
    const raw = { ifProxyOrDie: false, exceptions: {}, whitelist: [] };
    const [, empty] = createPacModifiers(raw);
    expect(empty.ifNoMods).to.equal(true);
    expect(cookPac(base, empty)).to.equal(base);
    const [, withPolicy] = createPacModifiers({ ...raw, siteResourceInheritance: { 'example.test': false } });
    expect(withPolicy.ifNoMods).to.equal(false);
  });
  it('limits reserve and DIRECT policy to own domains, leaving public PAC traffic unchanged', () => {
    const mods = { ...fixture(), filteredCustomsString: '', fallbackProxyChain: 'HTTPS reserve.test:443', ownProxyOrDie: true };
    expect(route(mods, 'unconfigured.test')).to.equal('HTTPS public.test:443');
    expect(route(mods, 'example.test')).to.equal('HTTPS a.test:443; HTTPS reserve.test:443');
    mods.ownProxyOrDie = false;
    mods.fallbackProxyChain = '';
    expect(route(mods, 'example.test')).to.equal('HTTPS a.test:443; DIRECT');
    expect(route(mods, 'unconfigured.test')).to.equal('HTTPS public.test:443');
  });
  it('adds the selected reserve only after a proxied route, without rerouting DIRECT sites or exposing credentials', () => {
    const raw = reconcileProxyProfiles({ customProxyStringRaw: 'HTTPS a.test:443; HTTP reserve:secret@b.test:8080',
      exceptions: { 'assigned.test': true, 'direct.test': false }, ifProxyOrDie: true });
    raw.domainProxyIds = { 'assigned.test': raw.proxyProfiles[0].id };
    raw.fallbackProxyId = raw.proxyProfiles[1].id;
    const [error, mods] = createPacModifiers(raw);
    expect(error).to.equal(null);
    expect(route(mods, 'assigned.test')).to.equal('HTTPS a.test:443; PROXY b.test:8080');
    expect(route(mods, 'direct.test')).to.equal('DIRECT');
    expect(cookPac(base, mods)).not.to.include('secret');
  });
  it('consumes real compiled routes without embedding credentials or catalog names', () => {
    const raw = reconcileProxyProfiles({ customProxyStringRaw: 'HTTPS user:secret@a.test:443\nHTTP b.test:8080',
      exceptions: { 'assigned.test': true } });
    const target = raw.proxyProfiles.find(profile => profile.endpoint.includes('a.test'));
    raw.domainProxyIds = { 'assigned.test': target.id };
    const [error, mods] = createPacModifiers(raw);
    expect(error).to.equal(null);
    expect(route(mods, 'assigned.test')).to.equal('HTTPS a.test:443');
    const cooked = cookPac(base, mods);
    expect(cooked).not.to.include('secret');
    expect(cooked).not.to.include('user:');
    expect(cooked).not.to.include('"name":');
  });
  it('real secure-only filtering never leaks an assigned insecure target to the legacy pool', () => {
    const raw = reconcileProxyProfiles({ customProxyStringRaw: 'HTTP a.test:8080\nHTTPS b.test:443',
      ifUseSecureProxiesOnly: true, ifProxyOrDie: false, exceptions: { 'assigned.test': true } });
    const target = raw.proxyProfiles.find(profile => profile.endpoint.includes('a.test'));
    raw.domainProxyIds = { 'assigned.test': target.id };
    const [error, mods] = createPacModifiers(raw);
    expect(error).to.equal(null);
    expect(route(mods, 'assigned.test')).to.equal('PROXY 127.0.0.1:9');
  });
  it('requires explicit opt-in for assigned DIRECT fallback', () => {
    const mods = fixture();
    delete mods.ifProxyOrDie;
    expect(route(mods, 'example.test')).to.equal('HTTPS a.test:443');
  });
  it('deduplicates a reserve equal to the assigned endpoint and keeps filtered reserves fail-closed', () => {
    expect(route({ ...fixture(), fallbackProxyChain: 'HTTPS a.test:443' }, 'example.test')).to.equal('HTTPS a.test:443');
    const raw = reconcileProxyProfiles({ customProxyStringRaw: 'HTTPS a.test:443; HTTP b.test:8080',
      ifUseSecureProxiesOnly: true, exceptions: { 'assigned.test': true } });
    raw.domainProxyIds = { 'assigned.test': raw.proxyProfiles[0].id };
    raw.fallbackProxyId = raw.proxyProfiles[1].id;
    const [error, mods] = createPacModifiers(raw);
    expect(error).to.equal(null);
    expect(route(mods, 'assigned.test')).to.equal('HTTPS a.test:443');
  });
  it('keeps automatic Tor outside own-domain failover and avoids DIRECT DNS leaks for onion sites', () => {
    const mods = { ...fixture(), ifUseLocalTor: true, ifProxyOrDie: false,
      torPoints: ['SOCKS5 localhost:9050'], fallbackProxyChain: 'HTTPS reserve.test:443' };
    expect(route(mods, 'unlisted.onion')).to.equal('SOCKS5 localhost:9050');
    mods.exceptions['legacy.onion'] = true;
    expect(route(mods, 'legacy.onion')).to.equal('SOCKS5 localhost:9050');
  });
  it('fails closed for absent or filtered targets regardless of fallback opt-in', () => {
    for (const ifProxyOrDie of [true, false]) {
      for (const ownProxyOrDie of [true, false]) {
        const mods = fixture();
        mods.ifProxyOrDie = ifProxyOrDie;
        mods.ownProxyOrDie = ownProxyOrDie;
        delete mods.proxyRoutes['custom:a'];
        expect(route(mods, 'example.test')).to.equal('PROXY 127.0.0.1:9');
      }
    }
  });
  it('honors opt-in DIRECT fallback on own routes independently of ifProxyOrDie and without replacement', () => {
    const pacRelaxed = { ...fixture(), ifProxyOrDie: false, replaceDirectWith: 'HTTPS b.test:443' };
    expect(route(pacRelaxed, 'example.test')).to.equal('HTTPS a.test:443');
    const ownRelaxed = { ...fixture(), ifProxyOrDie: true, ownProxyOrDie: false, replaceDirectWith: 'HTTPS b.test:443' };
    expect(route(ownRelaxed, 'example.test')).to.equal('HTTPS a.test:443; DIRECT');
  });
  it('applies explicit onion rules before Tor and retains legacy automatic Tor', () => {
    const mods = { ...fixture(), ifUseLocalTor: true, torPoints: ['SOCKS5 localhost:9050'] };
    mods.exceptions = { 'manual.onion': true, 'direct.onion': false, 'legacy.onion': true };
    mods.domainProxyIds = { 'manual.onion': 'custom:a' };
    mods.replaceDirectWith = 'HTTPS b.test:443';
    expect(route(mods, 'manual.onion')).to.equal('HTTPS a.test:443');
    expect(route(mods, 'direct.onion')).to.equal('DIRECT');
    expect(route(mods, 'legacy.onion')).to.equal('SOCKS5 localhost:9050');
    expect(route(mods, 'other.onion')).to.equal('SOCKS5 localhost:9050');
  });
  it('enforces global constraints before assigned rules', () => {
    const mods = { ...fixture(), ifProxyHttpsUrlsOnly: true, replaceDirectWith: 'HTTPS b.test:443' };
    expect(route(mods, 'example.test', 'http')).to.equal('DIRECT');
    mods.ifMindWhitelist = true;
    mods.whitelist = [];
    expect(route(mods, 'example.test')).to.equal('DIRECT');
  });
  it('uses only the winning rule target while keeping legacy pool fallback', () => {
    const mods = fixture();
    expect(route(mods, 'x.example.test')).to.equal('HTTPS a.test:443');
    expect(route(mods, 'x.sub.example.test')).to.equal('HTTPS b.test:443');
    expect(route(mods, 'legacy.test')).to.equal('HTTPS a.test:443; HTTPS b.test:443; HTTPS public.test:443');
  });
  it('uses canonical hostnames for whitelist, domain rules and Tor', () => {
    const mods = { ...fixture(), ifMindWhitelist: true, whitelist: ['example.test', 'hidden.onion'],
      ifProxyHttpsUrlsOnly: true, ifUseLocalTor: true, torPoints: ['SOCKS5 localhost:9050'] };
    expect(route(mods, 'EXAMPLE.TEST.', 'HTTPS')).to.equal('HTTPS a.test:443');
    expect(route(mods, 'HIDDEN.ONION.')).to.equal('SOCKS5 localhost:9050');
  });
});
