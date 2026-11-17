import { expect } from 'chai';
import { hasUnassignedResources, inheritResourceRules, planSiteRuleMode, setSiteRuleMode } from '../src/common/core/site-resource-rules.js';

describe('Site resource rule planning without browser state', () => {
  it('preserves manual root wildcards and the CDN they control on a site switch', () => {
    const current = { exceptions: { 'example.test': true, '*.example.test': true },
      domainProxyIds: { 'example.test': 'site-a', '*.example.test': 'manual-b' },
      ruleMeta: { 'exception:*.example.test': { source: 'manual' }, 'proxy:*.example.test': { source: 'manual' } } };
    const result = planSiteRuleMode(current, 'example.test', ['cdn.example.test'], false);
    expect(result.exceptions).to.deep.equal({ 'example.test': false, '*.example.test': true });
    expect(result.domainProxyIds).to.deep.equal({ '*.example.test': 'manual-b' });
  });
  it('turns automatic resources DIRECT with policy off without touching parent or manual suffix intent', () => {
    const record = { root: 'example.test', mainHost: 'www.example.test' };
    const current = { exceptions: { 'example.test': true, '*.manual.test': true },
      domainProxyIds: { 'example.test': 'parent', '*.manual.test': 'manual' },
      siteResourceInheritance: { 'example.test': false }, ifMindExceptions: true };
    const batches = [{ record, hosts: ['example.test', 'www.example.test', 'cdn.example.test', 'external.test', 'img.manual.test'] }];
    expect(hasUnassignedResources(current, batches)).to.equal(true);
    const result = inheritResourceRules(current, batches);
    expect(result.exceptions).to.deep.equal({ ...current.exceptions, 'cdn.example.test': false, 'external.test': false });
    expect(result.domainProxyIds).to.deep.equal(current.domainProxyIds);
    const planned = planSiteRuleMode(current, record.root, batches[0].hosts, true, 'next', record.mainHost);
    expect(planned.exceptions['cdn.example.test']).to.equal(false);
    expect(planned.domainProxyIds['cdn.example.test']).to.equal(undefined);
  });

  it('keeps inputs unchanged while respecting existing rules, undo suppression, and the first shared-CDN assignment', () => {
    const exceptions = Object.freeze({ 'example.com': false, 'other.test': true, '*.manual.test': true });
    const ruleMeta = Object.freeze({ 'exception:undone.test': Object.freeze({ suppressAuto: true }) });
    const current = Object.freeze({ exceptions, ruleMeta, ifMindExceptions: true });
    const direct = Object.freeze({ mainHost: 'www.example.com', root: 'example.com' });
    const proxy = Object.freeze({ mainHost: 'other.test', root: 'other.test' });
    const batches = [
      { record: direct, hosts: ['shared.test', 'images.manual.test', 'undone.test'] },
      { record: proxy, hosts: ['shared.test', 'own.test'] },
    ];
    expect(hasUnassignedResources(current, batches)).to.equal(true);
    const result = inheritResourceRules(current, batches, ruleMeta);
    expect(result.exceptions).to.deep.equal({ ...exceptions, 'shared.test': false, 'own.test': true });
    expect(result.siteForDomain).to.deep.equal({ 'shared.test': 'example.com', 'own.test': 'other.test' });
    expect([...result.changedRecords]).to.deep.equal([direct, proxy]);
    expect(hasUnassignedResources({ ...current, exceptions: result.exceptions }, batches)).to.equal(false);
    expect(exceptions).not.to.have.property('shared.test');
  });

  it('switches known subdomains and exact external resources without changing unrelated rules', () => {
    const original = Object.freeze({ '*.example.com': false, 'video.example.com': false,
      '*.cdn.test': false, 'unrelated.test': true });
    const hosts = new Set(['example.com', 'www.example.com', 'images.cdn.test']);
    expect(setSiteRuleMode(original, 'example.com', hosts, true)).to.deep.equal({
      ...original, '*.example.com': true, 'video.example.com': true,
      'example.com': true, 'www.example.com': true, 'images.cdn.test': true,
    });
    expect(original['video.example.com']).to.equal(false);
  });

  it('removes every controlling resource rule when returning to PAC, including shadowed parent rules', () => {
    const original = Object.freeze({ 'example.com': true, '*.example.com': false,
      'images.cdn.test': true, '*.cdn.test': false, 'cdn.test': true, 'unrelated.test': false });
    const result = setSiteRuleMode(original, 'example.com', new Set(['example.com', 'images.cdn.test']), null);
    expect(result).to.deep.equal({ 'unrelated.test': false });
    expect(original['images.cdn.test']).to.equal(true);
  });
});
