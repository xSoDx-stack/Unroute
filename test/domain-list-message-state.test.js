import { expect } from 'chai';
import * as messages from '../src/common/core/message-bus.js';

describe('Domain-list bridge to unchanged popup site selector', () => {
  const mods = { ifMindExceptions: true, exceptions: {}, domainProxyIds: {},
    domainLists: [{ id: 'meta', enabled: true, proxyId: 'a', domains: ['example.test'] }] };
  it('reports a list-only site as its actual assigned proxy without materializing an exception', () => {
    const match = messages.getConfiguredSiteMatch?.('www.example.test', mods);
    expect(match).to.include({ matched: true, isProxied: true, proxyId: 'a' });
    expect(mods.exceptions).to.deep.equal({});
  });
  it('keeps explicit PAC displayed as the existing unmatched PAC state rather than Direct', () => {
    const match = messages.getConfiguredSiteMatch?.('www.example.test', { ...mods, pacBypassDomains: ['example.test'] });
    expect(match).to.deep.equal({ matched: false });
  });
});
