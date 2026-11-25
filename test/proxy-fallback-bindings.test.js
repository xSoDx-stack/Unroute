import { strict as assert } from 'node:assert';
import * as profiles from '../src/common/core/proxy-profiles.js';
const setup = () => profiles.reconcileProxyProfiles({ customProxyStringRaw: 'HTTP a.test:80; HTTPS b.test:443' });
describe('fallback profile bindings and synthetic backups', () => {
  it('allows deleting the last unassigned proxy when it is the fallback', () => {
    let raw = profiles.reconcileProxyProfiles({ customProxyStringRaw: 'HTTPS a.test:443' });
    const id = raw.proxyProfiles[0].id;
    raw = profiles.reconcileProxyProfiles({ ...raw, fallbackProxyId: id }, raw);
    const result = profiles.deleteProxyProfile(raw, id);
    assert.deepEqual(result.proxyProfiles, []);
    assert.equal(result.fallbackProxyId, null);
  });
  it('rejects newly introduced invalid or disabled IDs', () => {
    const base = setup();
    for (const fallbackProxyId of [false, 1, {}, '', 'missing', 'builtin:tor']) assert.throws(() => profiles.reconcileProxyProfiles({ ...base, fallbackProxyId }, base));
    const secure = profiles.reconcileProxyProfiles({ ...base, ifUseSecureProxiesOnly: true }, base);
    assert.throws(() => profiles.reconcileProxyProfiles({ ...secure, fallbackProxyId: base.proxyProfiles[0].id }, secure), { code: 'PROXY_UNAVAILABLE' });
    const enabled = profiles.reconcileProxyProfiles({ ...base, fallbackProxyId: base.proxyProfiles[1].id }, base);
    assert.equal(enabled.fallbackProxyId, base.proxyProfiles[1].id);
    assert.equal(profiles.reconcileProxyProfiles({ ...enabled, fallbackProxyId: null }, enabled).fallbackProxyId, null);
  });
  it('keeps saved disabled fallback fail-closed and requires explicit replacement on deletion', () => {
    let base = setup(); const [a, b] = base.proxyProfiles;
    base = profiles.reconcileProxyProfiles({ ...base, fallbackProxyId: a.id }, base);
    const disabled = profiles.reconcileProxyProfiles({ ...base, ifUseSecureProxiesOnly: true }, base);
    assert.equal(disabled.fallbackProxyId, a.id);
    assert.equal(profiles.compileProxyRoutes(disabled)[a.id], undefined);
    assert.throws(() => profiles.reconcileProxyProfiles({ ...disabled, customProxyStringRaw: 'HTTPS b.test:443' }, disabled), { code: 'PROXY_REPLACEMENT_REQUIRED' });
    assert.throws(() => profiles.deleteProxyProfile(disabled, a.id), { code: 'PROXY_REPLACEMENT_REQUIRED' });
    assert.equal(profiles.deleteProxyProfile(disabled, a.id, b.id).fallbackProxyId, b.id);
    const backup = JSON.parse(JSON.stringify(disabled));
    assert.equal(profiles.reconcileProxyProfiles(backup).fallbackProxyId, a.id);
    assert.equal(profiles.reconcileProxyProfiles(backup, disabled).fallbackProxyId, a.id);
    const absent = { ...backup, fallbackProxyId: 'custom:00000000-0000-0000-0000-000000000001' };
    assert.equal(profiles.reconcileProxyProfiles(absent).fallbackProxyId, absent.fallbackProxyId);
    assert.throws(() => profiles.reconcileProxyProfiles(absent, disabled), { code: 'PROXY_UNAVAILABLE' });
  });
});
