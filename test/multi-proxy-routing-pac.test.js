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
  it('fails closed for absent or filtered targets regardless of fallback opt-in', () => {
    for (const ifProxyOrDie of [true, false]) {
      const mods = fixture();
      mods.ifProxyOrDie = ifProxyOrDie;
      delete mods.proxyRoutes['custom:a'];
      expect(route(mods, 'example.test')).to.equal('PROXY 127.0.0.1:9');
    }
  });
  it('honors opt-in DIRECT fallback without replacement or other targets', () => {
    const mods = { ...fixture(), ifProxyOrDie: false, replaceDirectWith: 'HTTPS b.test:443' };
    expect(route(mods, 'example.test')).to.equal('HTTPS a.test:443; DIRECT');
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
});
