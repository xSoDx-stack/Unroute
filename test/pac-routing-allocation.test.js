import { expect } from 'chai';
import vm from 'node:vm';
import { cookPac } from '../src/common/core/pac-script.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';

describe('PAC routing table allocation', () => {
  it('looks up layered domain suffixes without splitting or rejoining host labels', () => {
    const context = vm.createContext({});
    vm.runInContext(cookPac('function FindProxyForURL(){return "DIRECT";}', {
      ifMindExceptions: true,
      exceptions: { 'media.test': true, '*.media.test': false },
      pacBypassDomains: ['bypass.test'],
      filteredCustomsString: 'HTTPS own.test:443',
    }), context);
    vm.runInContext(`
      globalThis.labelSplits = 0;
      const split = String.prototype.split;
      String.prototype.split = function(separator) {
        if (separator === '.') labelSplits++;
        return split.apply(this, arguments);
      };
    `, context);
    expect(context.FindProxyForURL('https://media.test/', 'MEDIA.TEST.')).to.equal('HTTPS own.test:443');
    expect(context.FindProxyForURL('https://img.media.test/', 'img.media.test')).to.equal('DIRECT');
    expect(context.FindProxyForURL('https://img.bypass.test/', 'img.bypass.test')).to.equal('DIRECT');
    expect(context.labelSplits).to.equal(0);
  });

  it('does not parse static custom or reserve directives on each request', () => {
    const context = vm.createContext({});
    vm.runInContext(cookPac('function FindProxyForURL(){return "DIRECT";}', {
      ifMindExceptions: true,
      exceptions: { 'own.test': true },
      filteredCustomsString: ' HTTPS primary.test:443 ; direct ;; HTTPS primary.test:443 ',
      fallbackProxyChain: 'HTTPS primary.test:443; DIRECT; SOCKS5 reserve.test:1080; SOCKS5 reserve.test:1080',
      ownProxyOrDie: false,
    }), context);
    vm.runInContext(`
      globalThis.chainSplits = 0;
      const split = String.prototype.split;
      String.prototype.split = function(separator) {
        if (String(this).includes('primary.test')) chainSplits++;
        return split.apply(this, arguments);
      };
    `, context);
    for (const host of ['own.test', 'images.own.test']) {
      expect(context.FindProxyForURL('https://' + host + '/', host))
        .to.equal('HTTPS primary.test:443; HTTPS primary.test:443; SOCKS5 reserve.test:1080; DIRECT');
    }
    expect(context.chainSplits).to.equal(0);
  });

  it('keeps per-request source directives separate from static custom and reserve directives', () => {
    const context = vm.createContext({});
    vm.runInContext(cookPac(`function FindProxyForURL(url) {
      return url.endsWith('/via-pac') ? 'PROXY public.test:80; HTTPS secure.test:443; DIRECT' : 'DIRECT';
    }`, {
      ifMindExceptions: true,
      ifUsePacScriptProxies: true,
      ifUseSecureProxiesOnly: true,
      exceptions: { 'own.test': true },
      filteredCustomsString: 'HTTPS primary.test:443',
      fallbackProxyChain: 'HTTPS reserve.test:443',
    }), context);
    const route = (host, path) => context.FindProxyForURL(`https://${host}/${path}`, host);
    expect(route('own.test', 'via-pac')).to.equal('HTTPS primary.test:443; HTTPS secure.test:443; HTTPS reserve.test:443');
    expect(route('own.test', 'no-pac')).to.equal('HTTPS primary.test:443; HTTPS reserve.test:443');
    expect(route('public.test', 'via-pac')).to.equal('HTTPS primary.test:443; HTTPS secure.test:443');
    expect(route('public.test', 'no-pac')).to.equal('DIRECT');
  });

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
