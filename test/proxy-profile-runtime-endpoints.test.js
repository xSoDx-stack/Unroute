import { expect } from 'chai';
import { reconcileProxyProfiles, compileProxyRoutes } from '../src/common/core/proxy-profiles.js';

describe('Proxy identity must not rewrite connection targets', () => {
  it('retains an IPv6 loopback transport address instead of routing it to IPv4', () => {
    const raw = reconcileProxyProfiles({ customProxyStringRaw: 'HTTP [::1]:8080', exceptions: {} }, {});
    expect(compileProxyRoutes(raw)[raw.proxyProfiles[0].id]).to.equal('PROXY [::1]:8080');
  });
  it('does not conflate distinct IPv4 loopback listeners', () => {
    const raw = reconcileProxyProfiles({ customProxyStringRaw: 'HTTP 127.0.0.2:8080; HTTP 127.0.0.3:8080', exceptions: {} }, {});
    expect(raw.proxyProfiles).to.have.length(2);
    expect(Object.values(compileProxyRoutes(raw))).to.have.members(['PROXY 127.0.0.2:8080', 'PROXY 127.0.0.3:8080']);
  });
  it('removing an unbound default only changes future defaults and retains pinned routes', () => {
    let raw = reconcileProxyProfiles({ customProxyStringRaw: 'HTTP first.test:8080; HTTP second.test:8080', exceptions: { 'pinned.test': true } }, {});
    const [, second] = raw.proxyProfiles;
    raw = { ...raw, domainProxyIds: { 'pinned.test': second.id } };
    const next = reconcileProxyProfiles({ ...raw, customProxyStringRaw: 'HTTP second.test:8080' }, raw);
    expect(next.defaultProxyId).to.equal(second.id);
    expect(next.domainProxyIds).to.deep.equal(raw.domainProxyIds);
    expect(compileProxyRoutes(next)[second.id]).to.equal(compileProxyRoutes(raw)[second.id]);
  });
});
