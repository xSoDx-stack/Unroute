import { expect } from 'chai';
import { migrateSettings, recordRuleChange } from '../src/common/core/settings-schema.js';
import { encodeSettings, decodeSettings } from '../src/common/core/settings-codec.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';
import { matchResourceRule } from '../src/common/core/resource-routing.js';
import { inheritResourceRules } from '../src/common/core/site-resource-rules.js';

describe('Sparse per-site resource inheritance', () => {
  it('retains only canonical root:false entries through migration, compact cold load, and parsed settings', () => {
    const siteResourceInheritance = JSON.parse('{"example.com":false,"other.test":true,"a.example.com":false,"*.example.com":false,"https://bad.test":false,"__proto__":false,"constructor":false,"EXAMPLE.NET":false,"bad.test":"false"}');
    const migrated = migrateSettings({ siteResourceInheritance });
    expect(migrated.siteResourceInheritance).to.deep.equal({ 'example.com': false });
    const cold = migrateSettings(decodeSettings(encodeSettings(migrated)));
    expect(cold.siteResourceInheritance).to.deep.equal({ 'example.com': false });
    expect(createPacModifiers(cold)[1].siteResourceInheritance).to.deep.equal({ 'example.com': false });
    expect(migrateSettings({ siteResourceInheritance: [] }).siteResourceInheritance).to.deep.equal({});
  });

  it('increments rulesRevision even when the policy has no discovered resources', () => {
    const previous = migrateSettings({ _revision: 2, _rulesRevision: 5 });
    const next = recordRuleChange(previous, { ...previous, siteResourceInheritance: { 'example.com': false } });
    expect(next._revision).to.equal(3);
    expect(next._rulesRevision).to.equal(6);
    expect(recordRuleChange(next, { ...next, siteResourceInheritance: { 'example.com': false } })._rulesRevision).to.equal(6);
  });

  it('routes Firefox unknown resources immediately, preserves manual resources, and never splits the main host', () => {
    const mods = { exceptions: { 'example.com': true, '*.manual.test': true },
      siteResourceInheritance: { 'example.com': false } };
    expect(matchResourceRule(mods, 'cdn.example.com', 'www.example.com', true).isProxied).to.equal(false);
    expect(matchResourceRule(mods, 'new.cdn.test', 'www.example.com', true).isProxied).to.equal(false);
    expect(matchResourceRule(mods, 'img.manual.test', 'www.example.com', true).ruleKey).to.equal('*.manual.test');
    expect(matchResourceRule(mods, 'www.example.com', 'www.example.com', true).isProxied).to.equal(true);
    expect(matchResourceRule(mods, 'example.com', 'www.example.com', true).isProxied).to.equal(true);
  });

  it('does not convert a site-owned plain parent suffix or either actual parent host to DIRECT', () => {
    const record = { root: 'example.com', mainHost: 'www.example.com' };
    const auto = { source: 'site', site: record.root };
    const current = { exceptions: { 'example.com': true, 'www.example.com': true },
      domainProxyIds: { 'example.com': 'parent', 'www.example.com': 'parent' },
      ruleMeta: { 'exception:example.com': auto, 'exception:www.example.com': auto },
      siteResourceInheritance: { 'example.com': false } };
    const result = inheritResourceRules(current, [{ record, hosts: ['example.com', 'www.example.com', 'cdn.example.com'] }]);
    expect(result.exceptions).to.deep.equal({ ...current.exceptions, 'cdn.example.com': false });
    expect(result.domainProxyIds).to.deep.equal(current.domainProxyIds);
  });

  it('never changes parent-owning wildcards from the checkbox and refreshes matched owned resource wildcards', () => {
    const record = { root: 'example.com', mainHost: 'www.example.com' };
    const auto = { source: 'site', site: record.root };
    const current = { exceptions: { '*.example.com': true, '*.cdn.test': true },
      domainProxyIds: { '*.example.com': 'parent', '*.cdn.test': 'old' },
      ruleMeta: { 'exception:*.example.com': auto, 'exception:*.cdn.test': auto },
      siteResourceInheritance: { 'example.com': false } };
    const result = inheritResourceRules(current, [{ record, hosts: ['*.example.com', 'img.example.com', 'img.cdn.test'] }]);
    expect(result.exceptions).to.deep.equal({ '*.example.com': true, 'img.example.com': false, '*.cdn.test': false });
    expect(result.domainProxyIds).to.deep.equal({ '*.example.com': 'parent' });
  });

  it('updates persisted owned wildcards, respects independently edited proxy provenance and clears PAC-owned DIRECT', () => {
    const record = { root: 'example.com', mainHost: 'www.example.com' };
    const auto = { source: 'auto', site: record.root };
    const current = { exceptions: { '*.owned.test': true, 'assigned.test': true },
      domainProxyIds: { '*.owned.test': 'old', 'assigned.test': 'manual' },
      ruleMeta: { 'exception:*.owned.test': auto, 'proxy:*.owned.test': auto,
        'exception:assigned.test': auto, 'proxy:assigned.test': { source: 'manual' } },
      siteResourceInheritance: { 'example.com': false } };
    const result = inheritResourceRules(current, [{ record, hosts: ['*.owned.test', 'assigned.test'] }]);
    expect(result.exceptions).to.deep.equal({ '*.owned.test': false, 'assigned.test': true });
    expect(result.domainProxyIds).to.deep.equal({ 'assigned.test': 'manual' });
    const enabled = inheritResourceRules({ ...current, ...result, siteResourceInheritance: {} }, [{ record, hosts: ['*.owned.test'] }]);
    expect(enabled.exceptions).to.deep.equal({ 'assigned.test': true });
  });

  it('removes auto DIRECT on enable for a PAC parent but does not manufacture routes for unknown PAC resources', () => {
    const record = { root: 'example.com', mainHost: 'www.example.com' };
    const current = { exceptions: { 'cdn.test': false },
      ruleMeta: { 'exception:cdn.test': { source: 'auto', site: 'example.com' } } };
    const result = inheritResourceRules(current, [{ record, hosts: ['cdn.test', 'unknown.test'] }]);
    expect(result.exceptions).to.deep.equal({});
    expect(result.domainProxyIds).to.deep.equal({});
    expect(result.siteForDomain).to.deep.equal({ 'cdn.test': 'example.com' });
  });
});
