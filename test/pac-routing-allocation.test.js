import { expect } from 'chai';
import vm from 'node:vm';
import { cookPac } from '../src/common/core/pac-script.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';

describe('PAC routing table allocation', () => {
  it('reuses the exact and wildcard tables across requests instead of rebuilding a large list', () => {
    const exceptions = Object.fromEntries(Array.from({ length: 33000 }, (_, index) => [`site-${index}.test`, true]));
    exceptions['*.direct.test'] = false;
    const [, mods] = createPacModifiers({ exceptions, customProxyStringRaw: 'HTTPS own.test:443' });
    const context = vm.createContext({});
    vm.runInContext(cookPac('function FindProxyForURL(){return "DIRECT";}', mods), context);
    // A missing-key getter observes the actual lookup receiver. New dictionary
    // instances on each call would grow this set, regardless of hardware speed.
    vm.runInContext(`
      globalThis.observedTables = new Set();
      Object.defineProperty(Object.prototype, 'allocation-probe.test', {
        get() { observedTables.add(this); return undefined; },
      });
    `, context);
    for (let index = 0; index < 100; index++) {
      expect(context.FindProxyForURL(`https://allocation-probe.test/${index}`, 'allocation-probe.test')).to.equal('DIRECT');
    }
    expect(context.observedTables.size).to.equal(2);
    expect(context.FindProxyForURL('https://site-32999.test/', 'site-32999.test')).to.include('own.test:443');
    expect(context.FindProxyForURL('https://image.direct.test/', 'image.direct.test')).to.equal('DIRECT');
  });
});
