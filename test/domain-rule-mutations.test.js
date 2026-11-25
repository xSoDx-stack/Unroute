import { expect } from 'chai';
import { applyDomainRuleMutations, assignDomainProxies, replaceDomainRuleLists } from '../src/common/core/domain-rule-mutations.js';

describe('Raw domain rule replacement', () => {
  it('accepts a large disjoint replacement without raising the public delta cap', () => {
    const rules = prefix => Object.fromEntries(Array.from({ length: 50_001 }, (_, i) => [`${prefix}${i}.test`, false]));
    const replacement = rules('new');
    const result = replaceDomainRuleLists({ exceptions: rules('old') }, { exceptions: replacement }, { expectedRevision: 0 });
    expect(Object.keys(result.settings.exceptions)).to.have.length(50_001);
    expect(result.settings.exceptions).not.to.have.property('old0.test');
    expect(result.settings.exceptions['new50000.test']).to.equal(false);
  });

  it('rejects conflicting entries and preserves an explicit rule replacing PAC bypass', () => {
    const raw = { pacBypassDomains: ['example.test'] };
    expect(() => replaceDomainRuleLists(raw, { exceptions: { 'example.test': false }, pacBypassDomains: ['EXAMPLE.TEST'] },
      { expectedRevision: 0 })).to.throw();
    const result = replaceDomainRuleLists(raw, { exceptions: { 'example.test': false }, pacBypassDomains: [] }, { expectedRevision: 0 });
    expect(result.settings.exceptions).to.deep.equal({ 'example.test': false });
    expect(result.settings.pacBypassDomains).to.deep.equal([]);
    expect(result).to.include({ added: 0, changed: 1 });
  });
});

const catalog = [
  { id: 'custom:a', enabled: true }, { id: 'custom:b', enabled: true },
  { id: 'builtin:tor', enabled: false },
];
const seed = () => ({ _rulesRevision: 7, exceptions: { 'old.test': true, 'direct.test': false },
  domainProxyIds: { 'old.test': 'custom:a' }, whitelist: ['allowed.test'] });

describe('Pure domain routing mutations', () => {
  it('requires a target for new positive rules with several eligible profiles', () => {
    expect(() => applyDomainRuleMutations(seed(), [{ domain: 'new.test', mode: 'proxy' }], { catalog }))
      .to.throw().with.property('code', 'PROXY_SELECTION_REQUIRED');
  });
  it('normalizes keys, pins the chosen ID and never mutates input', () => {
    const raw = seed();
    const result = applyDomainRuleMutations(raw, [{ domain: 'HTTPS://NEW.TEST/path', mode: 'proxy', proxyId: 'custom:b' }], { catalog });
    expect(result.settings.exceptions['new.test']).to.equal(true);
    expect(result.settings.domainProxyIds['new.test']).to.equal('custom:b');
    expect(raw.exceptions).not.to.have.property('new.test');
    expect(result).to.include({ added: 1, changed: 0, unchanged: 0 });
  });
  it('auto-pins the sole available proxy and allows PAC-only rules with none', () => {
    const operation = [{ domain: 'new.test', mode: 'proxy' }];
    expect(applyDomainRuleMutations(seed(), operation, { catalog: catalog.slice(0, 1) }).settings.domainProxyIds['new.test']).to.equal('custom:a');
    expect(applyDomainRuleMutations(seed(), operation).settings.domainProxyIds).not.to.have.property('new.test');
  });
  it('preserves an existing assignment and legacy unassigned routes unless explicitly moved', () => {
    const raw = { ...seed(), exceptions: { ...seed().exceptions, 'legacy.test': true } };
    const result = applyDomainRuleMutations(raw, [{ domain: 'old.test', mode: 'proxy' }, { domain: 'legacy.test', mode: 'proxy' }], { catalog });
    expect(result.settings.domainProxyIds).to.deep.equal(raw.domainProxyIds);
    expect(result).to.include({ added: 0, changed: 0, unchanged: 2 });
  });
  it('rejects disabled and unknown targets without changing the input', () => {
    for (const proxyId of ['builtin:tor', 'missing']) {
      const raw = seed();
      expect(() => applyDomainRuleMutations(raw, [{ domain: 'old.test', mode: 'proxy', proxyId }], { catalog }))
        .to.throw().with.property('code', 'PROXY_TARGET_UNAVAILABLE');
      expect(raw.domainProxyIds['old.test']).to.equal('custom:a');
    }
  });
  it('removes assignments atomically for direct/reset operations', () => {
    for (const mode of ['direct', 'pac']) {
      const result = applyDomainRuleMutations(seed(), [{ domain: 'old.test', mode }], { catalog });
      expect(result.settings.domainProxyIds).not.to.have.property('old.test');
      expect(result.settings.exceptions['old.test']).to.equal(mode === 'direct' ? false : undefined);
      expect(result.changed).to.equal(1);
    }
  });
  it('rejects stale raw replacements and bulk moves', () => {
    expect(() => replaceDomainRuleLists(seed(), { exceptions: {} }, { catalog, expectedRevision: 6 }))
      .to.throw().with.property('code', 'RULES_CONFLICT');
    expect(() => assignDomainProxies(seed(), ['old.test'], 'custom:b', { catalog }))
      .to.throw().with.property('code', 'RULES_REVISION_REQUIRED');
  });
  it('bulk-moves current positives without touching other domains and reports real changes', () => {
    const result = assignDomainProxies(seed(), ['old.test', 'OLD.TEST'], 'custom:b', { catalog, expectedRevision: 7 });
    expect(result.settings.domainProxyIds).to.deep.equal({ 'old.test': 'custom:b' });
    expect(result.settings.exceptions['direct.test']).to.equal(false);
    expect(result).to.include({ added: 0, changed: 1, unchanged: 0 });
    expect(() => assignDomainProxies(seed(), ['direct.test'], 'custom:b', { catalog, expectedRevision: 7 }))
      .to.throw().with.property('code', 'PROXY_RULE_MISSING');
  });
  it('counts repeated unchanged imports honestly and preserves assignments', () => {
    const operations = [{ domain: 'old.test', mode: 'proxy' }, { domain: 'old.test', mode: 'proxy' }];
    expect(applyDomainRuleMutations(seed(), operations, { catalog })).to.include({ added: 0, changed: 0, unchanged: 1 });
  });
  it('raw round-trips preserve assignments while removals/direct transitions clean them', () => {
    const result = replaceDomainRuleLists(seed(), { exceptions: { 'old.test': true, 'direct.test': false, 'new.test': true } },
      { catalog, expectedRevision: 7, proxyId: 'custom:b' });
    expect(result.settings.domainProxyIds).to.deep.equal({ 'old.test': 'custom:a', 'new.test': 'custom:b' });
    const direct = replaceDomainRuleLists(result.settings, { exceptions: { 'old.test': false } }, { catalog, expectedRevision: 7 });
    expect(direct.settings.domainProxyIds).to.deep.equal({});
  });
  it('rejects malformed input atomically instead of skipping corrupted rows', () => {
    expect(() => applyDomainRuleMutations(seed(), [{ domain: 'new.test', mode: 'proxy', proxyId: 'custom:b' }, { domain: '__proto__', mode: 'direct' }], { catalog })).to.throw();
    expect(() => replaceDomainRuleLists(seed(), { exceptions: { 'bad.test': 'proxy' } }, { expectedRevision: 7 }))
      .to.throw().with.property('code', 'INVALID_DOMAIN_MUTATION');
  });
  it('supports whitelist deltas without losing concurrent values', () => {
    const raw = seed();
    const result = applyDomainRuleMutations(raw, [{ domain: 'other.test', mode: 'whitelist-add' }]);
    expect(result.settings.whitelist).to.deep.equal(['allowed.test', 'other.test']);
    expect(result.settings.exceptions).to.equal(raw.exceptions);
    expect(result.added).to.equal(1);
  });
});
