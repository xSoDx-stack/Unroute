import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { toggleWildcardDomain, toggleWildcardLines } from '../src/common/core/domain-rules.js';

describe('wildcard prefix toggle (*.domain)', () => {
  it('adds and removes *. on valid domains while skipping IPv4 addresses', () => {
    assert.deepEqual(toggleWildcardDomain('example.ru'), {
      valid: true,
      domain: '*.example.ru',
      changed: true,
    });
    assert.deepEqual(toggleWildcardDomain('*.example.ru'), {
      valid: true,
      domain: 'example.ru',
      changed: true,
    });
    assert.deepEqual(toggleWildcardDomain('1.1.1.1', false), {
      valid: true,
      domain: '1.1.1.1',
      changed: false,
      skippedIp: true,
    });
    assert.deepEqual(toggleWildcardDomain('*.1.1.1.1', true), {
      valid: true,
      domain: '1.1.1.1',
      changed: true,
    });
  });

  it('toggles the domain on the current cursor line without losing caret offset', () => {
    const src = '# ПРОКСИРОВАТЬ:\nexample.ru\nother.org\n';
    const cursor = src.indexOf('example.ru') + 4;
    const added = toggleWildcardLines(src, cursor, cursor);
    assert.equal(added.changed, true);
    assert.equal(added.text, '# ПРОКСИРОВАТЬ:\n*.example.ru\nother.org\n');
    assert.equal(added.selectionStart, cursor + 2);
    assert.equal(added.selectionEnd, cursor + 2);

    const removed = toggleWildcardLines(added.text, added.selectionStart, added.selectionEnd);
    assert.equal(removed.changed, true);
    assert.equal(removed.text, src);
    assert.equal(removed.selectionStart, cursor);
  });

  it('toggles multi-line selection, skipping comments, separators, blank lines, and IPs', () => {
    const src = [
      '# ПРОКСИРОВАТЬ:',
      'alpha.ru # inline comment',
      '*.beta.ru',
      '192.168.1.1',
      '',
      '===============================',
      '# НЕ ПРОКСИРОВАТЬ:',
      'gamma.org',
    ].join('\n');

    // First toggle on mixed selection: adds *. where missing so all become *.
    const first = toggleWildcardLines(src, 0, src.length);
    assert.equal(first.changed, true);
    assert.equal(first.text, [
      '# ПРОКСИРОВАТЬ:',
      '*.alpha.ru # inline comment',
      '*.beta.ru',
      '192.168.1.1',
      '',
      '===============================',
      '# НЕ ПРОКСИРОВАТЬ:',
      '*.gamma.org',
    ].join('\n'));

    // Second toggle on all-wildcard selection: removes *. from all selected domains
    const second = toggleWildcardLines(first.text, first.selectionStart, first.selectionEnd);
    assert.equal(second.changed, true);
    assert.equal(second.text, [
      '# ПРОКСИРОВАТЬ:',
      'alpha.ru # inline comment',
      'beta.ru',
      '192.168.1.1',
      '',
      '===============================',
      '# НЕ ПРОКСИРОВАТЬ:',
      'gamma.org',
    ].join('\n'));
  });
});
