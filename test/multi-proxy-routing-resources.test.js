import { expect } from 'chai';
import { inheritResourceRules, planSiteRuleMode, hasUnassignedResources } from '../src/common/core/site-resource-rules.js';

describe('Multi-proxy resource inheritance', () => {
  it('inherits the winning wildcard ID atomically without overwriting manual resources', () => {
    const current = { exceptions: { '*.site.test': true, 'site.test': false, 'manual.test': true },
      domainProxyIds: { '*.site.test': 'custom:a', 'manual.test': 'custom:b' } };
    const record = { mainHost: 'www.site.test', root: 'site.test' };
    const result = inheritResourceRules(current, [{ record, hosts: ['cdn.test', 'manual.test'] }]);
    expect(result.exceptions['cdn.test']).to.equal(true);
    expect(result.domainProxyIds).to.deep.equal({ ...current.domainProxyIds, 'cdn.test': 'custom:a' });
    expect(current.domainProxyIds).not.to.have.property('cdn.test');
    expect(result.siteForDomain['cdn.test']).to.equal('site.test');
  });
  it('refreshes owned automatic assignments but protects separately edited proxy provenance', () => {
    const current = { exceptions: { 'site.test': true, 'cdn.test': true, 'manual.test': true },
      domainProxyIds: { 'site.test': 'custom:b', 'cdn.test': 'custom:a', 'manual.test': 'custom:a' } };
    const ruleMeta = {
      'exception:cdn.test': { source: 'auto', site: 'site.test' },
      'proxy:cdn.test': { source: 'auto', site: 'site.test' },
      'exception:manual.test': { source: 'auto', site: 'site.test' },
      'proxy:manual.test': { source: 'manual' },
    };
    const result = inheritResourceRules(current, [{ record: { mainHost: 'site.test', root: 'site.test' },
      hosts: ['cdn.test', 'manual.test'] }], ruleMeta);
    expect(result.domainProxyIds['cdn.test']).to.equal('custom:b');
    expect(result.domainProxyIds['manual.test']).to.equal('custom:a');
    const batches = [{ record: { mainHost: 'site.test', root: 'site.test' }, hosts: ['cdn.test'] }];
    expect(hasUnassignedResources({ ...current, ruleMeta }, batches)).to.equal(true);
    expect(hasUnassignedResources({ ...current, domainProxyIds: result.domainProxyIds, ruleMeta }, batches)).to.equal(false);
  });
  it('a site switch does not steal independent manual proxy provenance', () => {
    const current = { exceptions: { 'site.test': true, 'cdn.test': true },
      domainProxyIds: { 'site.test': 'custom:a', 'cdn.test': 'custom:b' },
      ruleMeta: { 'exception:cdn.test': { source: 'auto', site: 'site.test' },
        'proxy:cdn.test': { source: 'manual' } } };
    const result = planSiteRuleMode(current, 'site.test', new Set(['site.test', 'cdn.test']), false);
    expect(result.exceptions['cdn.test']).to.equal(true);
    expect(result.domainProxyIds['cdn.test']).to.equal('custom:b');
    expect(result.touchedDomains.has('cdn.test')).to.equal(false);
  });
  it('never applies the new default retroactively to legacy positive rules', () => {
    const current = { exceptions: { 'site.test': true }, defaultProxyId: 'custom:a' };
    const result = inheritResourceRules(current, [{ record: { mainHost: 'site.test', root: 'site.test' }, hosts: ['cdn.test'] }]);
    expect(result.exceptions['cdn.test']).to.equal(true);
    expect(result.domainProxyIds).to.deep.equal({});
  });
});
