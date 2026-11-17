import { expect } from 'chai';
import vm from 'node:vm';
import { planSiteRuleMode, inheritResourceRules } from '../src/common/core/site-resource-rules.js';
import { matchResourceRule } from '../src/common/core/resource-routing.js';
import { cookPac } from '../src/common/core/pac-script.js';

const owned = { source: 'site', site: 'site.test' };
const record = { root: 'site.test', mainHost: 'www.site.test' };
function fixture() {
  return { ifMindExceptions: true, defaultProxyId: 'custom:a',
    exceptions: { 'site.test': true, 'www.site.test': false, 'manual.site.test': true,
      'direct.site.test': false, '*.assets.site.test': true, 'owned.site.test': true,
      'assigned.site.test': true, 'other.test': true },
    domainProxyIds: { 'site.test': 'custom:a', 'manual.site.test': 'custom:missing',
      '*.assets.site.test': 'custom:b', 'owned.site.test': 'custom:a',
      'assigned.site.test': 'custom:b', 'other.test': 'custom:b' },
    ruleMeta: { 'exception:owned.site.test': owned, 'proxy:owned.site.test': owned,
      'exception:assigned.site.test': owned, 'proxy:assigned.site.test': { source: 'manual' } },
    proxyRoutes: { 'custom:a': 'HTTPS a.test:443', 'custom:b': 'HTTPS b.test:443' } };
}
const hosts = new Set(['site.test', 'www.site.test', 'manual.site.test', 'direct.site.test',
  'img.assets.site.test', 'owned.site.test', 'assigned.site.test', 'fresh.test']);

describe('Current-site proxy selection contract', () => {
  for (const mode of [true, false, null]) {
    it(`preserves independent same-root manual and wildcard resources for mode ${mode}`, () => {
      const current = fixture();
      const result = planSiteRuleMode(current, record.root, hosts, mode, 'custom:b', record.mainHost);
      for (const key of ['manual.site.test', 'direct.site.test', '*.assets.site.test', 'assigned.site.test', 'other.test']) {
        expect(result.exceptions[key], key).to.equal(current.exceptions[key]);
        expect(result.domainProxyIds[key], key).to.equal(current.domainProxyIds[key]);
        expect(result.touchedDomains.has(key), key).to.equal(false);
      }
      expect(result.exceptions).not.to.have.property('img.assets.site.test');
      for (const key of ['site.test', 'www.site.test', 'owned.site.test', 'fresh.test']) {
        if (mode === null) expect(result.exceptions).not.to.have.property(key);
        else expect(result.exceptions[key], key).to.equal(mode);
      }
      expect(current.defaultProxyId).to.equal('custom:a');
    });
  }

  it('updates owned resources even when not observed in the current tab', () => {
    const result = planSiteRuleMode(fixture(), record.root, new Set(['site.test']), true, 'custom:b', record.mainHost);
    expect(result.domainProxyIds['owned.site.test']).to.equal('custom:b');
    expect(result.exceptions['www.site.test']).to.equal(true);
  });

  it('refreshes site-owned late resources without stealing manual assignments', () => {
    const current = fixture();
    current.exceptions['www.site.test'] = true;
    current.domainProxyIds['www.site.test'] = 'custom:b';
    const result = inheritResourceRules(current, [{ record, hosts: [...hosts, 'late.test'] }]);
    expect(result.domainProxyIds['owned.site.test']).to.equal('custom:b');
    expect(result.domainProxyIds['late.test']).to.equal('custom:b');
    expect(result.domainProxyIds['manual.site.test']).to.equal('custom:missing');
    expect(result.domainProxyIds['assigned.site.test']).to.equal('custom:b');
    expect(result.exceptions).not.to.have.property('img.assets.site.test');
  });

  it('Firefox follows site-owned rules but keeps manual exact, DIRECT, wildcard and missing IDs', () => {
    const current = fixture();
    current.exceptions['www.site.test'] = true;
    current.domainProxyIds['www.site.test'] = 'custom:b';
    expect(matchResourceRule(current, 'owned.site.test', record.mainHost, true).ruleKey).to.equal(record.mainHost);
    for (const [host, key] of [['manual.site.test', 'manual.site.test'], ['direct.site.test', 'direct.site.test'],
      ['img.assets.site.test', '*.assets.site.test'], ['assigned.site.test', 'assigned.site.test']]) {
      expect(matchResourceRule(current, host, record.mainHost, true).ruleKey).to.equal(key);
    }
  });

  it('cooked Chromium PAC preserves same-root manual precedence and fails closed for missing IDs', () => {
    const current = fixture();
    const planned = planSiteRuleMode(current, record.root, hosts, true, 'custom:b', record.mainHost);
    const context = vm.createContext({});
    vm.runInContext(cookPac('function FindProxyForURL(){return "DIRECT";}', { ...current, ...planned }), context);
    const route = host => context.FindProxyForURL(`https://${host}/`, host);
    expect(route('www.site.test')).to.equal('HTTPS b.test:443');
    expect(route('direct.site.test')).to.equal('DIRECT');
    expect(route('img.assets.site.test')).to.equal('HTTPS b.test:443');
    expect(route('manual.site.test')).not.to.match(/DIRECT|a\.test|b\.test/);
  });
});
