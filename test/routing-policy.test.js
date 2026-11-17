import { expect } from 'chai';
import vm from 'node:vm';
import { routeConstraint, compilePolicy } from '../src/common/core/routing-policy.js';
import { cookPac } from '../src/common/core/pac-script.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';

describe('Shared routing constraints in native PAC', () => {
  it('enforces the same whitelist/HTTPS decisions even with a global DIRECT replacement', () => {
    const [, mods] = createPacModifiers({ ifMindWhitelist: true, whitelist: ['*.allowed.test'],
      ifProxyHttpsUrlsOnly: true, replaceDirectWith: 'HTTPS replacement.test:443',
      customProxyStringRaw: 'HTTPS own.test:443', exceptions: { 'allowed.test': true, 'other.test': true } });
    const compiled = compilePolicy(mods);
    const sandbox = {};
    vm.runInNewContext(cookPac('function FindProxyForURL(){return "PROXY original.test:443";}', mods), sandbox);
    for (const url of ['http://allowed.test/', 'wss://sub.allowed.test/', 'https://other.test/', 'https://sub.allowed.test/']) {
      const host = new URL(url).hostname;
      const constraint = routeConstraint(url, host, compiled.policy, compiled.whitelist);
      const route = sandbox.FindProxyForURL(url, host);
      expect(route === 'DIRECT', url).to.equal(Boolean(constraint));
      if (!constraint) expect(route).to.include('own.test');
    }
  });
});
