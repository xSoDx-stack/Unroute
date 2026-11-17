import { expect } from 'chai';
import { encodeSettings, clearSettingsCodecCache } from '../src/common/core/settings-codec.js';
import { migrateSettings, recordRuleChange, undoRuleChange } from '../src/common/core/settings-schema.js';

describe('Compact persisted domain rules', () => {
  afterEach(clearSettingsCodecCache);

  it('round-trips rule precedence, whitelist, ownership, undo suppression and preferences', () => {
    let raw = migrateSettings({ exceptions: {}, whitelist: [], customProxyStringRaw: 'HTTPS user:secret@proxy.test:443' });
    raw = recordRuleChange(raw, { ...raw, exceptions: { 'site.test': true, '*.site.test': false, 'cdn.test': true },
      whitelist: ['*.site.test'] }, { source: 'import' }, 1000);
    const importId = raw.ruleHistory[0].id;
    raw = recordRuleChange(raw, { ...raw, exceptions: { ...raw.exceptions, 'cdn.test': false } }, { source: 'manual' }, 2000);
    raw = recordRuleChange(raw, undoRuleChange(raw, importId).settings, { source: 'undo' });
    const packed = encodeSettings(raw);
    expect(packed).not.to.have.property('exceptions');
    expect(packed._ruleData).not.to.include('secret');
    const restored = migrateSettings(structuredClone(packed));
    // Compare with a legacy cold reload, which normalizes optional metadata.
    expect(restored).to.deep.equal(migrateSettings(structuredClone(raw)));
    expect(restored.ruleMeta['exception:site.test'].suppressAuto).to.equal(true);
    expect(restored.exceptions['cdn.test']).to.equal(false);
    expect(undoRuleChange(restored).settings.exceptions).to.deep.equal(undoRuleChange(raw).settings.exceptions);
  });

  it('stores 33000 domains once and shares the provenance of a bulk operation', () => {
    const before = migrateSettings({ exceptions: {}, whitelist: [] });
    const exceptions = Object.fromEntries(Array.from({ length: 33000 }, (_, index) => [`site-${index}.example.test`, true]));
    const raw = recordRuleChange(before, { ...before, exceptions }, { source: 'import' }, 1000);
    expect(raw.ruleMeta['exception:site-0.example.test']).to.equal(raw.ruleMeta['exception:site-32999.example.test']);
    const packed = encodeSettings(raw);
    const [domains, provenance] = JSON.parse(packed._ruleData);
    expect(domains).to.have.length(33000);
    expect(provenance).to.have.length(1);
    expect(JSON.stringify(packed).length).to.be.lessThan(JSON.stringify(raw).length * 0.4);
    const restored = migrateSettings(structuredClone(packed));
    expect(restored).to.deep.equal(raw);
    expect(restored.ruleMeta['exception:site-0.example.test']).to.equal(restored.ruleMeta['exception:site-32999.example.test']);
    expect(undoRuleChange(restored).restored).to.equal(33000);
  // This 33k synchronous round-trip checks correctness, not wall-clock speed.
  // Allow CPU contention/GC; small tests retain Mocha's default 2s budget.
  }).timeout(30_000);

  it('keeps distinct originating sites and prior ownership in the metadata pool', () => {
    const before = migrateSettings({ exceptions: {}, whitelist: [] });
    const raw = recordRuleChange(before, { ...before, exceptions: { 'cdn-a.test': true, 'cdn-b.test': false } },
      { source: 'auto', siteForDomain: { 'cdn-a.test': 'a.test', 'cdn-b.test': 'b.test' } }, 1000);
    const updated = recordRuleChange(raw, { ...raw, exceptions: { ...raw.exceptions, 'cdn-a.test': false } }, {}, 2000);
    const restored = migrateSettings(encodeSettings(updated));
    expect(restored).to.deep.equal(updated);
    expect(restored.ruleMeta['exception:cdn-b.test'].site).to.equal('b.test');
    expect(restored.ruleHistory[0].changes[0].beforeMeta.site).to.equal('a.test');
  });

  it('preserves long legacy rule keys and treats prototype names as own data', () => {
    const domain = Array(5).fill('a'.repeat(60)).join('.');
    const exceptions = JSON.parse(`{"${domain}":true,"__proto__":false}`);
    const raw = migrateSettings({ exceptions, whitelist: [] });
    const restored = migrateSettings(encodeSettings(raw));
    expect(restored.exceptions[domain]).to.equal(true);
    expect(Object.hasOwn(restored.exceptions, '__proto__')).to.equal(true);
    expect(restored.exceptions['__proto__']).to.equal(false);
    expect(Object.getPrototypeOf(restored.exceptions)).to.equal(Object.prototype);
  });

  it('reuses encoded rules for preference changes and reencodes after invalidation', () => {
    const raw = migrateSettings({ exceptions: { 'site.test': true }, whitelist: [] });
    const packed = encodeSettings(raw);
    const stringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = (...args) => { calls++; return stringify(...args); };
    try {
      const next = encodeSettings({ ...raw, ifProxyOrDie: false });
      expect(next._ruleData).to.equal(packed._ruleData);
      expect(next.ifProxyOrDie).to.equal(false);
      expect(calls).to.equal(0);
      clearSettingsCodecCache();
      encodeSettings(raw);
      expect(calls).to.be.greaterThan(0);
    } finally { JSON.stringify = stringify; }
  });

  it('rejects corrupt compact data instead of treating it as an empty list', () => {
    const raw = migrateSettings({ exceptions: { 'site.test': true }, whitelist: [] });
    const packed = encodeSettings(raw);
    const corruptions = [null, [], [[], [], [], [], [], []]];
    const badIndex = JSON.parse(packed._ruleData);
    badIndex[2][0] = 99;
    corruptions.push(badIndex);
    const badValue = JSON.parse(packed._ruleData);
    badValue[2][1] = null;
    corruptions.push(badValue);
    // Empty tables are a valid empty list, so corrupt the table stride too.
    corruptions[2][2] = [0];
    for (const value of corruptions) {
      expect(() => migrateSettings({ ...packed, _ruleData: JSON.stringify(value) })).to.throw('формат');
    }
    expect(() => migrateSettings({ ...packed, _ruleData: '{' })).to.throw('формат');
    expect(() => migrateSettings({ ...packed, _schemaVersion: 99 })).to.throw('более новой');
  });
});
