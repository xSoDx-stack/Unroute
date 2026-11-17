import { expect } from 'chai';
import { migrateSettings, recordRuleChange, undoRuleChange } from '../src/common/core/settings-schema.js';
import { encodeSettings, decodeSettings } from '../src/common/core/settings-codec.js';
import { reconcileProxyProfiles } from '../src/common/core/proxy-profiles.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';

const setup = () => migrateSettings(reconcileProxyProfiles({ customProxyStringRaw: 'HTTPS a.test:443; HTTPS b.test:443', exceptions: { 'site.test': true }, whitelist: [] }));
describe('Proxy assignments schema and compact codec', () => {
  it('shares 33000 assignments and codec data for preferences without moving maps into preferences', () => {
    const base = setup(); const id = base.proxyProfiles[0].id;
    const exceptions = Object.fromEntries(Array.from({ length: 33000 }, (_, index) => [`site-${index}.test`, true]));
    const domainProxyIds = Object.fromEntries(Object.keys(exceptions).map(domain => [domain, id]));
    const raw = recordRuleChange(base, { ...base, exceptions, domainProxyIds }, { source: 'import' });
    const packed = encodeSettings(raw);
    expect(packed).not.to.have.property('domainProxyIds');
    expect(migrateSettings(packed).domainProxyIds).to.deep.equal(domainProxyIds);
    const preferred = recordRuleChange(raw, { ...raw, ifProxyOrDie: false }, { preferencesOnly: true });
    expect(preferred.domainProxyIds).to.equal(raw.domainProxyIds);
    expect(preferred.exceptions).to.equal(raw.exceptions);
    expect(preferred.ruleMeta).to.equal(raw.ruleMeta);
    expect(preferred.ruleHistory).to.equal(raw.ruleHistory);
    expect(encodeSettings(preferred)._ruleData).to.equal(packed._ruleData);
  // This 33k synchronous round-trip checks correctness, not wall-clock speed.
  // Allow CPU contention/GC; small tests retain Mocha's default 2s budget.
  }).timeout(30_000);
  it('rejects new nonpositive/unknown bindings, but removes old bindings when rules become direct', () => {
    const base = setup(); const id = base.proxyProfiles[0].id;
    expect(() => recordRuleChange(base, { ...base, domainProxyIds: { 'direct.test': id } })).to.throw();
    expect(() => recordRuleChange(base, { ...base, domainProxyIds: { 'site.test': 'custom:missing' } })).to.throw();
    const bound = recordRuleChange(base, { ...base, domainProxyIds: { 'site.test': id } });
    const direct = recordRuleChange(bound, { ...bound, exceptions: { 'site.test': false } });
    expect(direct.domainProxyIds).to.deep.equal({});
    const undone = undoRuleChange(direct);
    expect(undone.settings.domainProxyIds['site.test']).to.equal(id);
  });
  it('filters WARP to HTTPS under secure-only while preserving the Tor exception', () => {
    const [error, mods] = createPacModifiers({ ifUseLocalWarp: true, ifUseLocalTor: true, ifUseSecureProxiesOnly: true });
    expect(error).to.equal(null);
    expect(mods.warpPoints).to.deep.equal(['HTTPS localhost:40000']);
    expect(mods.torPoints).to.include('SOCKS5 localhost:9150');
  });
  it('records assignment-only changes with independent ownership and undo', () => {
    const base = setup(); const [a, b] = base.proxyProfiles;
    const first = recordRuleChange(base, { ...base, domainProxyIds: { 'site.test': a.id } });
    const next = recordRuleChange(first, { ...first, domainProxyIds: { 'site.test': b.id } });
    expect(next._rulesRevision).to.equal(first._rulesRevision + 1);
    expect(next.ruleHistory[0].changes[0]).to.include({ kind: 'proxy', before: a.id, after: b.id });
    expect(next.ruleMeta['proxy:site.test'].revision).to.equal(next._revision);
    expect(undoRuleChange(next).settings.domainProxyIds['site.test']).to.equal(a.id);
    const deleted = { ...next, proxyProfiles: [b] };
    expect(undoRuleChange(deleted).skipped).to.equal(1);
  });
  it('packs assignments separately and roundtrips string history in versioned tables', () => {
    const base = setup(); const id = base.proxyProfiles[0].id;
    const raw = recordRuleChange(base, { ...base, domainProxyIds: { 'site.test': id } });
    const packed = encodeSettings(raw);
    expect(packed).not.to.have.property('domainProxyIds');
    expect(JSON.parse(packed._ruleData)).to.have.length(9);
    expect(decodeSettings(packed).domainProxyIds).to.deep.equal(raw.domainProxyIds);
    expect(migrateSettings(packed).ruleHistory).to.deep.equal(migrateSettings(raw).ruleHistory);
    expect(decodeSettings({ _ruleData: '[[],[],[],[],[],[]]' }).domainProxyIds).to.deep.equal({});
  });
  it('exposes runtime registry and compiled auth-free routes', () => {
    const base = setup(); const id = base.proxyProfiles[0].id;
    const [error, mods] = createPacModifiers({ ...base, domainProxyIds: { 'site.test': id } });
    expect(error).to.equal(null);
    expect(mods.proxyProfiles).to.equal(base.proxyProfiles);
    expect(mods.proxyRoutes[id]).to.equal('HTTPS a.test:443');
    expect(mods.domainProxyIds['site.test']).to.equal(id);
  });
});
