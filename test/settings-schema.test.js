import { expect } from 'chai';
import { migrateSettings, recordRuleChange, undoRuleChange, describeHistory, clearRuleHistory, SETTINGS_SCHEMA_VERSION } from '../src/common/core/settings-schema.js';
import { matchConfiguredRule } from '../src/common/core/domain-route-resolver.js';

describe('Versioned settings and safe rule undo', () => {
  const edit = (before, exceptions, context = {}) => recordRuleChange(before, { ...before, exceptions }, context);
  it('migrates legacy snapshots without losing rules, credentials, or preferences', () => {
    const legacy = { exceptions: { 'example.test': false }, customProxyStringRaw: 'HTTPS u:p@proxy.test:443', ifProxyOrDie: false };
    const result = migrateSettings(legacy);
    expect(result).to.include(legacy);
    expect(result._schemaVersion).to.equal(SETTINGS_SCHEMA_VERSION);
    expect(result._revision).to.equal(0);
    expect(result._rulesRevision).to.equal(0);
    expect(migrateSettings({ _revision: 7 })._rulesRevision).to.equal(7);
    expect(migrateSettings({ _revision: 7, _rulesRevision: -1 })._rulesRevision).to.equal(7);
    expect(() => migrateSettings({ _schemaVersion: 99 })).to.throw('более новой');
    expect(legacy).not.to.have.property('_schemaVersion');
  });
  it('rejects malformed explicit schema versions instead of bypassing legacy control migration', () => {
    for (const _schemaVersion of ['bad', '3', -1, 1.5, null, {}, []]) {
      expect(() => migrateSettings({ _schemaVersion })).to.throw('формат');
    }
  });

  it('preserves legacy same-site controls above new lists on cold migration and undo', () => {
    const metadata = { source: 'site', revision: 1, site: 'site.test', updatedAt: 1 };
    const raw = { _schemaVersion: 2, _revision: 2, exceptions: { 'site.test': false, 'www.site.test': false, 'cdn.test': false },
      ruleMeta: { 'exception:site.test': metadata, 'exception:www.site.test': { ...metadata, revision: 2 }, 'exception:cdn.test': metadata },
      ruleHistory: [{ id: 'r2', revision: 2, source: 'manual', changes: [
        { kind: 'exception', domain: 'www.site.test', before: true, after: false, beforeMeta: metadata },
      ] }] };
    const migrated = migrateSettings(raw);
    const domainLists = [{ id: 'list:main', enabled: true, proxyId: 'b', domains: ['www.site.test', 'cdn.test'] }];
    expect(matchConfiguredRule('www.site.test', { ...migrated, domainLists })).to.include({ isProxied: false }).and.not.have.property('listId');
    // A legacy cross-site CDN is not guessed to be the selected main host.
    expect(migrated.ruleMeta['exception:cdn.test']).not.to.have.property('siteControl');
    expect(migrated.ruleMeta['exception:www.site.test'].siteControl).to.equal(true);
    expect(migrated.ruleHistory[0].changes[0].beforeMeta.siteControl).to.equal(true);
    const undone = undoRuleChange(migrated).settings;
    expect(matchConfiguredRule('www.site.test', { ...undone, domainLists })).to.include({ isProxied: true }).and.not.have.property('listId');
    expect(metadata).not.to.have.property('siteControl');
  });

  it('restores a site batch but preserves later manual edits, including same-mode clicks', () => {
    let raw = migrateSettings({ exceptions: { 'site.test': false } });
    raw = edit(raw, { 'site.test': true, 'cdn.test': true, 'image.test': true }, { source: 'site', site: 'site.test' });
    const operation = raw.ruleHistory[0].id;
    raw = edit(raw, { ...raw.exceptions }, { source: 'manual', touchedDomains: ['cdn.test'] });
    raw = edit(raw, { ...raw.exceptions, 'image.test': false });
    const undo = undoRuleChange(raw, operation);
    expect(undo.restored).to.equal(1);
    expect(undo.skipped).to.equal(2);
    expect(undo.settings.exceptions).to.deep.equal({ 'site.test': false, 'cdn.test': true, 'image.test': false });
  });
  it('tracks deletions, supports sequential undo, and suppresses automatic re-addition', () => {
    let raw = migrateSettings({ exceptions: {} });
    raw = edit(raw, { 'cdn.test': true }, { source: 'auto', siteForDomain: { 'cdn.test': 'site.test' } });
    const addition = raw.ruleHistory[0].id;
    expect(raw.ruleMeta['exception:cdn.test'].site).to.equal('site.test');
    raw = edit(raw, {}, { source: 'manual' });
    const deletion = raw.ruleHistory[0].id;
    raw = recordRuleChange(raw, undoRuleChange(raw, deletion).settings, { source: 'undo' });
    expect(raw.exceptions['cdn.test']).to.equal(true);
    raw = recordRuleChange(raw, undoRuleChange(raw, addition).settings, { source: 'undo' });
    expect(raw.exceptions).to.deep.equal({});
    expect(raw.ruleMeta['exception:cdn.test'].suppressAuto).to.equal(true);
    raw = edit(raw, { 'cdn.test': false });
    expect(raw.ruleMeta['exception:cdn.test'].suppressAuto).not.to.equal(true);
  });
  it('undoes whitelist membership and keeps history free of proxy credentials', () => {
    const before = migrateSettings({ exceptions: {}, whitelist: ['old.test'], customProxyStringRaw: 'HTTPS secret:password@proxy.test:443' });
    const next = recordRuleChange(before, { ...before, whitelist: ['new.test'] }, { source: 'import' });
    expect(undoRuleChange(next).settings.whitelist).to.deep.equal(['old.test']);
    expect(JSON.stringify(next.ruleHistory)).not.to.include('password');
    expect(describeHistory(next)[0]).to.have.property('count', 2).and.not.have.property('changes');
  });
  it('reuses rule metadata/history for preferences and bounds retained operations', () => {
    let raw = migrateSettings({ exceptions: {} });
    for (let i = 0; i < 20; i++) raw = edit(raw, { ...raw.exceptions, [`site${i}.test`]: true });
    expect(raw.ruleHistory.map(item => item.id)).to.deep.equal(['r20', 'r19', 'r18', 'r17', 'r16']);
    const next = recordRuleChange(raw, { ...raw, ifProxyOrDie: false });
    expect(next.ruleMeta).to.equal(raw.ruleMeta);
    expect(next.ruleHistory).to.equal(raw.ruleHistory);
    expect(next._revision).to.equal(raw._revision + 1);
    expect(next._rulesRevision).to.equal(raw._rulesRevision);
  });
  it('trims existing twelve-entry history to the five newest operations on load', () => {
    const ruleHistory = Array.from({ length: 12 }, (_, i) => ({
      id: `r${12 - i}`, revision: 12 - i, source: 'auto', changes: [
        { kind: 'exception', domain: `site${i}.test`, before: null, after: true },
      ],
    }));
    const raw = migrateSettings({ exceptions: { 'live.test': false }, ruleHistory });
    expect(raw.ruleHistory.map(item => item.id)).to.deep.equal(['r12', 'r11', 'r10', 'r9', 'r8']);
    expect(describeHistory(raw)).to.have.length(5);
    expect(raw.exceptions).to.deep.equal({ 'live.test': false });
    expect(ruleHistory).to.have.length(12);
  });
  it('advances the list revision for rule edits, provenance changes, undo and metadata cleanup', () => {
    const original = migrateSettings({ exceptions: {}, whitelist: [] });
    const added = edit(original, { 'site.test': true });
    expect(added._rulesRevision).to.equal(original._rulesRevision + 1);
    const touched = edit(added, { ...added.exceptions }, { touchedDomains: ['site.test'] });
    expect(touched._rulesRevision).to.equal(added._rulesRevision + 1);
    const undone = recordRuleChange(added, undoRuleChange(added).settings, { source: 'undo' });
    expect(undone._rulesRevision).to.equal(added._rulesRevision + 1);
    const deleted = edit(added, {});
    const cleaned = recordRuleChange(deleted, clearRuleHistory(deleted), { metadataOnly: true });
    expect(cleaned._revision).to.equal(deleted._revision);
    expect(cleaned._rulesRevision).to.equal(deleted._rulesRevision + 1);
  });
  it('retains the list revision when history cleanup or a superseded undo changes no rule data', () => {
    const added = edit(migrateSettings({ exceptions: {} }), { 'site.test': true });
    const touched = edit(added, { ...added.exceptions }, { touchedDomains: ['site.test'] });
    const cleaned = recordRuleChange(touched, clearRuleHistory(touched), { metadataOnly: true });
    expect(cleaned.ruleMeta).to.equal(touched.ruleMeta);
    expect(cleaned._rulesRevision).to.equal(touched._rulesRevision);
    const undo = undoRuleChange(touched, added.ruleHistory[0].id);
    expect(undo.restored).to.equal(0);
    expect(undo.skipped).to.equal(1);
    const skipped = recordRuleChange(touched, undo.settings, { source: 'undo' });
    expect(skipped._rulesRevision).to.equal(touched._rulesRevision);
    expect(skipped.exceptions).to.equal(touched.exceptions);
    expect(skipped.ruleMeta).to.equal(touched.ruleMeta);
  });
  it('ignores malformed optional metadata/history without losing valid legacy rules', () => {
    const raw = migrateSettings({ exceptions: { 'valid.test': true }, ruleMeta: { bad: 'x' },
      ruleHistory: [null, {}, { id: 'r1', revision: 1, changes: [null, { kind: 'unsafe', domain: 'x' }] }] });
    expect(raw.exceptions['valid.test']).to.equal(true);
    expect(raw.ruleMeta).to.deep.equal({});
    expect(describeHistory(raw)).to.have.length(1);
    expect(() => edit(raw, { ...raw.exceptions, 'next.test': false })).not.to.throw();
  });
  it('stores only a summary for an oversized import and does not partially undo it', () => {
    const before = migrateSettings({ exceptions: {} });
    const after = edit(before, Object.fromEntries(Array.from({ length: 50001 }, (_, i) => [`s${i}.test`, true])), { source: 'import' });
    expect(after.ruleHistory[0]).to.include({ truncated: true, count: 50001 });
    expect(after.ruleHistory[0].changes).to.have.length(0);
    expect(() => undoRuleChange(after)).to.throw('слишком велико');
    expect(after.exceptions).to.have.property('s50000.test', true);
  });
  it('purges deleted rule history while preserving live rules and automatic-add suppression', () => {
    let raw = edit(migrateSettings({ exceptions: {} }), { 'cdn.test': true });
    raw = recordRuleChange(raw, undoRuleChange(raw).settings, { source: 'undo' });
    raw = edit(raw, { 'live.test': false, 'deleted.test': true });
    raw = edit(raw, { 'live.test': false });
    const cleared = recordRuleChange(raw, clearRuleHistory(raw), { metadataOnly: true });
    expect(cleared.ruleHistory).to.deep.equal([]);
    expect(cleared.ruleMeta).not.to.have.property('exception:deleted.test');
    expect(cleared.ruleMeta['exception:cdn.test'].suppressAuto).to.equal(true);
    expect(cleared.exceptions).to.deep.equal(raw.exceptions);
    expect(cleared._revision).to.equal(raw._revision);
  });
});
