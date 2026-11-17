import { expect } from 'chai';
import { TabProxyRouter } from '../src/common/core/tab-proxy-router.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';
import { planSiteRuleMode } from '../src/common/core/site-resource-rules.js';

describe('Reviewed manual rule precedence', () => {
  it('preserves an unassigned manual proxy resource instead of inheriting a DIRECT tab route', async () => {
    const original = { get: pacKitchen.getPacMods, settings: proxyBackend.getSettings };
    try {
      pacKitchen.getPacMods = async () => ({ ifMindExceptions: true, exceptions: { 'page.test': false, 'legacy.test': true },
        filteredCustomsString: 'HTTPS pool.test:443', domainProxyIds: {},
        ruleMeta: { 'exception:legacy.test': { source: 'manual' } } });
      proxyBackend.getSettings = async () => ({ levelOfControl: 'controlled_by_this_extension', value: { proxyType: 'autoConfig' } });
      const router = new TabProxyRouter();
      router.tabs.set(1, 'page.test');
      expect(await router.handle({ tabId: 1, type: 'image', url: 'https://legacy.test/image' }))
        .to.deep.equal([{ type: 'https', host: 'pool.test', port: 443 }, null]);
    } finally { pacKitchen.getPacMods = original.get; proxyBackend.getSettings = original.settings; }
  });
  it('keeps external manual DIRECT/legacy-positive rules when changing the parent site mode', () => {
    for (const value of [false, true]) {
      const current = { exceptions: { 'page.test': true, 'cdn.test': value }, domainProxyIds: {},
        ruleMeta: { 'exception:cdn.test': { source: 'manual' } } };
      const result = planSiteRuleMode(current, 'page.test', new Set(['page.test', 'cdn.test']), !value, 'custom:a');
      expect(result.exceptions['cdn.test']).to.equal(value);
      expect(result.domainProxyIds).not.to.have.property('cdn.test');
      expect(result.touchedDomains.has('cdn.test')).to.equal(false);
    }
  });
  it('honors a manual assignment even when the domain itself was discovered automatically', async () => {
    const original = { get: pacKitchen.getPacMods, settings: proxyBackend.getSettings };
    try {
      pacKitchen.getPacMods = async () => ({ ifMindExceptions: true, exceptions: { 'page.test': true, 'cdn.test': true },
        domainProxyIds: { 'page.test': 'custom:a', 'cdn.test': 'custom:b' },
        proxyRoutes: { 'custom:a': 'HTTPS first.test:443', 'custom:b': 'HTTPS second.test:443' },
        ruleMeta: { 'exception:cdn.test': { source: 'auto', site: 'page.test' }, 'proxy:cdn.test': { source: 'manual' } } });
      proxyBackend.getSettings = async () => ({ levelOfControl: 'controlled_by_this_extension', value: { proxyType: 'autoConfig' } });
      const router = new TabProxyRouter(); router.tabs.set(1, 'page.test');
      expect((await router.handle({ tabId: 1, type: 'image', url: 'https://cdn.test/image' }))[0].host).to.equal('second.test');
    } finally { pacKitchen.getPacMods = original.get; proxyBackend.getSettings = original.settings; }
  });
  it('keeps a manual proxy assignment on an automatic CDN when resetting its original parent site', () => {
    const current = { exceptions: { 'page.test': true, 'cdn.test': true }, domainProxyIds: { 'cdn.test': 'custom:b' },
      ruleMeta: { 'exception:cdn.test': { source: 'auto', site: 'page.test' }, 'proxy:cdn.test': { source: 'manual' } } };
    const result = planSiteRuleMode(current, 'page.test', new Set(['page.test', 'cdn.test']), null);
    expect(result.exceptions['cdn.test']).to.equal(true);
    expect(result.domainProxyIds['cdn.test']).to.equal('custom:b');
  });
});
