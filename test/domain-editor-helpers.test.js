import assert from 'node:assert/strict';
import { createDomainCardIndex } from '../src/common/pages/options/domain-cards-list.js';
import { parseListText, readListFile } from '../src/common/pages/options/domain-file-io.js';

describe('domain editor helpers', () => {
  it('caches display order without changing raw order and combines the active filters', () => {
    const snapshot = {
      exceptions: {'z.test': true, 'a.test': true, 'd.test': false},
      whitelist: ['z.test', 'a.test'], pacBypassDomains: ['c.test'],
    };
    const filters = {query: '', source: '', proxy: '', ruleMeta: {'exception:z.test': {source: 'popup'}}, domainProxyIds: {'a.test': 'p1'}};
    const index = createDomainCardIndex(snapshot);
    const included = index.filter('included', filters);
    assert.deepEqual(included, ['a.test', 'z.test']);
    assert.strictEqual(index.filter('included', filters), included);
    assert.deepEqual(index.filter('included', {...filters, query: '.test', source: 'popup', proxy: 'legacy'}), ['z.test']);
    assert.deepEqual(index.filter('included', {...filters, source: 'popup', proxy: 'p1'}), []);
    assert.deepEqual(index.filter('excluded', filters), ['d.test']);
    assert.deepEqual(index.filter('whitelist', filters), ['a.test', 'z.test']);
    assert.deepEqual(snapshot.whitelist, ['z.test', 'a.test']);
    assert.equal(index.count('pac'), 1);
  });

  it('accepts strict UTF-8 and rejects binary controls and invalid UTF-8', async () => {
    const file = data => new File([data], 'domains.TXT');
    const text = '\uFEFFhttps://example.test/a\r\nsecond.test\r\n';
    const parsed = await readListFile(file(text));
    assert.deepEqual(parsed.validDomains, ['example.test', 'second.test']);
    assert.deepEqual(parsed.validDomains, parseListText(text).validDomains);
    await assert.rejects(readListFile(file('example.test\0\n')));
    await assert.rejects(readListFile(file(Uint8Array.of(0xc3, 0x28))));
  });
});
