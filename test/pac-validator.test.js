'use strict';

import { expect } from 'chai';
import { validatePacScriptSource } from '../src/common/core/pac-validator.js';
import { Parser } from '../src/common/vendor/acorn.mjs';

describe('PAC source validation', () => {
  it('scans an unchanged valid PAC once, without trusting changed or invalid text', () => {
    const source = '// validation cache regression\nfunction FindProxyForURL(){return "DIRECT";}';
    const original = Parser.prototype.parse;
    let scans = 0;
    Parser.prototype.parse = function() {
      scans++;
      return original.call(this);
    };
    try {
      const first = validatePacScriptSource(source);
      expect(first.valid).to.equal(true);
      expect(scans).to.be.greaterThan(0);
      scans = 0;
      first.valid = false;
      expect(validatePacScriptSource(source).valid).to.equal(true);
      expect(scans).to.equal(0);
      expect(validatePacScriptSource(source + '}').valid).to.equal(false);
      expect(scans).to.be.greaterThan(0);
      expect(validatePacScriptSource(source + '\n// another source').valid).to.equal(true);
      scans = 0;
      expect(validatePacScriptSource(source).valid).to.equal(true);
      expect(scans).to.be.greaterThan(0, 'Only the last valid source may be cached');
    } finally {
      Parser.prototype.parse = original;
    }
  });
  it('accepts top-level declarations and direct function assignments', () => {
    expect(validatePacScriptSource(
      'function FindProxyForURL(url, host) { return "DIRECT"; }',
    ).valid).to.equal(true);
    expect(validatePacScriptSource(
      'var FindProxyForURL = function(url, host) { return "DIRECT"; };',
    ).valid).to.equal(true);
    expect(validatePacScriptSource(
      'globalThis.FindProxyForURL = (url, host) => "DIRECT";',
    ).valid).to.equal(true);
  });

  it('accepts immediately invoked wrappers that return or publish the PAC function', () => {
    for (const source of [
      'var FindProxyForURL = (function() { return function(url, host) { return "DIRECT"; }; })();',
      '(function() { self.FindProxyForURL = (url, host) => "DIRECT"; })();',
    ]) expect(validatePacScriptSource(source).valid, source).to.equal(true);
  });

  it('rejects balanced but invalid JavaScript', () => {
    expect(validatePacScriptSource('function FindProxyForURL() { const value = ; }').valid).to.equal(false);
  });

  it('does not mistake comments, strings or regular expressions for PAC code', () => {
    const decoys = [
      '// function FindProxyForURL(url, host) {}',
      'const text = "function FindProxyForURL(url, host) {}";',
      'const matcher = /FindProxyForURL/;',
      'FindProxyForURL = "DIRECT"\nfunction helper() {}',
      'FindProxyForURL = [1, 2].map(x => x);',
      'FindProxyForURL = (x => x)("DIRECT");',
      'const holder = {}; holder.FindProxyForURL = function() {};',
      '(function() { function FindProxyForURL() { return "DIRECT"; } })();',
    ];

    for (const source of decoys) {
      const result = validatePacScriptSource(source);
      expect(result.valid).to.equal(false);
      expect(result.error).to.include('FindProxyForURL');
    }
  });

  it('rejects empty and truncated responses before changing proxy settings', () => {
    expect(validatePacScriptSource('   ').valid).to.equal(false);
    expect(validatePacScriptSource('function FindProxyForURL(url, host)').valid)
      .to.equal(false);
    const truncated = validatePacScriptSource(
      'function FindProxyForURL(url, host) { if (host) { return "DIRECT";',
    );
    expect(truncated.valid).to.equal(false);
    expect(truncated.error).to.match(/оборван|синтаксическ/);
  });
});
