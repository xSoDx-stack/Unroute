import { expect } from 'chai';
import { applyDomainRuleMutations, replaceDomainRuleLists } from '../src/common/core/domain-rule-mutations.js';
import { inheritResourceRules, planSiteRuleMode, resetExactResourceRule } from '../src/common/core/site-resource-rules.js';

describe('Manual overrides above domain lists', () => {
  it('stores explicit PAC intent separately, removing only the exact boolean/profile override', () => {
    const domainLists = [{ id: 'meta', name: 'Meta', proxyId: 'a', enabled: true, domains: ['example.test'] }];
    const raw = { exceptions: { 'example.test': true, 'other.test': false }, domainProxyIds: { 'example.test': 'b' }, domainLists };
    const result = applyDomainRuleMutations(raw, [{ domain: 'example.test', mode: 'pac-bypass' }]);
    expect(result.settings.exceptions).to.deep.equal({ 'other.test': false });
    expect(result.settings.domainProxyIds).to.deep.equal({});
    expect(result.settings.pacBypassDomains).to.deep.equal(['example.test']);
    expect(result.settings.domainLists).to.equal(domainLists);
    expect(raw.exceptions['example.test']).to.equal(true);
    expect(result.changed).to.equal(1);
  });
  it('site PAC selection persists parent intent without modifying independent resource overrides', () => {
    const raw = { exceptions: { 'example.test': true, 'manual.cdn.test': false }, domainProxyIds: { 'example.test': 'a' },
      pacBypassDomains: ['keep.cdn.test'] };
    const result = planSiteRuleMode(raw, 'example.test', new Set(['www.example.test', 'keep.cdn.test']), null, null, 'www.example.test');
    expect(result.pacBypassDomains).to.have.members(['example.test', 'www.example.test', 'keep.cdn.test']);
    expect(result.exceptions).to.deep.equal({ 'manual.cdn.test': false });
    expect(raw.pacBypassDomains).to.deep.equal(['keep.cdn.test']);
  });
  it('changing the parent proxy never promotes a manually PAC-exempt resource to an automatic proxy rule', () => {
    const raw = { exceptions: { 'example.test': true }, domainProxyIds: { 'example.test': 'a' },
      pacBypassDomains: ['*.cdn.test', 'example.test'] };
    const result = planSiteRuleMode(raw, 'example.test', new Set(['asset.cdn.test']), true, 'b');
    expect(result.exceptions).not.to.have.property('asset.cdn.test');
    expect(result.pacBypassDomains).to.deep.equal(['*.cdn.test']);
    expect(result.domainProxyIds['example.test']).to.equal('b');
  });
  it('exact reset removes a manual PAC marker but preserves its remaining wildcard', () => {
    const raw = { exceptions: { 'example.test': true }, domainProxyIds: { 'example.test': 'a' },
      pacBypassDomains: ['*.cdn.test', 'asset.cdn.test'] };
    const result = resetExactResourceRule(raw, { root: 'example.test', mainHost: 'example.test' }, 'asset.cdn.test');
    expect(result.pacBypassDomains).to.deep.equal(['*.cdn.test']);
    expect(result.exceptions).not.to.have.property('asset.cdn.test');
    expect(raw.pacBypassDomains).to.deep.equal(['*.cdn.test', 'asset.cdn.test']);
  });
  it('raw PAC-tab replacement is revision guarded and leaves independent lists and other manual domains untouched', () => {
    const raw = { _rulesRevision: 4, exceptions: { 'keep.test': false }, pacBypassDomains: ['old.test'],
      domainLists: [{ id: 'meta', domains: ['old.test'] }] };
    const result = replaceDomainRuleLists(raw, { pacBypassDomains: ['new.test'] }, { expectedRevision: 4 });
    expect(result.settings.pacBypassDomains).to.deep.equal(['new.test']);
    expect(result.settings.exceptions).to.deep.equal({ 'keep.test': false });
    expect(result.settings.domainLists).to.equal(raw.domainLists);
    expect(() => replaceDomainRuleLists(raw, { pacBypassDomains: [] }, { expectedRevision: 3 })).to.throw();
  });
  it('automatic resources inherit the named proxy of a site matched only by a list', () => {
    const raw = { ifMindExceptions: true, exceptions: {}, domainProxyIds: {},
      domainLists: [{ id: 'meta', enabled: true, proxyId: 'a', domains: ['example.test'] }] };
    const result = inheritResourceRules(raw, [{ record: { root: 'example.test', mainHost: 'www.example.test' },
      hosts: new Set(['asset.cdn.test']) }]);
    expect(result.exceptions['asset.cdn.test']).to.equal(true);
    expect(result.domainProxyIds['asset.cdn.test']).to.equal('a');
  });
  it('site changes and exact resets do not overwrite an independent resource list', () => {
    const raw = { exceptions: { 'example.test': true }, domainProxyIds: { 'example.test': 'a' },
      domainLists: [{ id: 'ai', enabled: true, proxyId: 'b', domains: ['asset.cdn.test'] }] };
    const planned = planSiteRuleMode(raw, 'example.test', new Set(['asset.cdn.test']), true, 'a');
    expect(planned.exceptions).not.to.have.property('asset.cdn.test');
    const reset = resetExactResourceRule({ ...raw, exceptions: { ...raw.exceptions, 'asset.cdn.test': true },
      domainProxyIds: { ...raw.domainProxyIds, 'asset.cdn.test': 'a' } },
    { root: 'example.test', mainHost: 'example.test' }, 'asset.cdn.test');
    expect(reset.exceptions).not.to.have.property('asset.cdn.test');
    expect(reset.domainLists).to.equal(raw.domainLists);
  });
});
