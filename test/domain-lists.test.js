import { expect } from 'chai';
import { migrateSettings, recordRuleChange, undoRuleChange } from '../src/common/core/settings-schema.js';
import { encodeSettings, decodeSettings, clearSettingsCodecCache } from '../src/common/core/settings-codec.js';
import { reconcileProxyProfiles, deleteProxyProfile, getProxyCatalog } from '../src/common/core/proxy-profiles.js';
import { setupMessageBus, serializePacMods } from '../src/common/core/message-bus.js';
import { appState } from '../src/common/core/app-state.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { storage } from '../src/common/core/storage.js';

let lists;
before(async () => { lists = await import('../src/common/core/domain-lists.js').catch(() => ({})); });

describe('Canonical ordered domain lists', () => {
  it('does not reuse validation results for edited input arrays or rows', () => {
    const domains = ['old.test'];
    const list = { id: 'a', name: 'A', proxyId: 'p', enabled: true, domains };
    const input = [list];
    const snapshot = lists.normalizeDomainLists(input);
    domains[0] = 'new.test';
    list.proxyId = 'next';
    expect(snapshot[0]).to.include({ proxyId: 'p' });
    expect(snapshot[0].domains).to.deep.equal(['old.test']);
    expect(lists.normalizeDomainLists(input)[0]).to.deep.equal({ ...list, domains: ['new.test'] });
    domains.push('invalid');
    expect(() => lists.normalizeListDomains(domains)).to.throw().with.property('code', 'INVALID_DOMAIN_LIST');
    expect(() => lists.normalizeDomainLists(input)).to.throw().with.property('code', 'INVALID_DOMAIN_LIST');
    expect(lists.normalizeDomainLists(snapshot)).to.equal(snapshot);
  });

  it('updates matching for editable lists without invalidating canonical snapshots', () => {
    const row = { id: 'a', name: 'A', proxyId: 'p', enabled: true, domains: ['old.test'] };
    const input = [row];
    const snapshot = lists.normalizeDomainLists(input);
    expect(lists.matchDomainLists('old.test', input).matched).to.equal(true);
    expect(lists.matchDomainLists('old.test', snapshot).matched).to.equal(true);
    row.domains[0] = 'new.test';
    expect(lists.matchDomainLists('old.test', input).matched).to.equal(false);
    expect(lists.matchDomainLists('new.test', input).matched).to.equal(true);
    expect(lists.matchDomainLists('old.test', snapshot).matched).to.equal(true);
    row.enabled = false;
    expect(lists.matchDomainLists('new.test', input).matched).to.equal(false);
  });

  it('disambiguates legacy duplicate names without changing IDs, routes or list contents', () => {
    const values = ['Work', 'work', 'Work (2)'].map((name, i) => ({ id: `l${i}`, name, proxyId: 'p', enabled: true, domains: [`d${i}.test`] }));
    const result = lists.normalizeDomainLists(values);
    expect(result.map(list => list.name)).to.deep.equal(['Work', 'work (3)', 'Work (2)']);
    expect(result.map(({ name: _name, ...rest }) => rest)).to.deep.equal(values.map(({ name: _name, ...rest }) => rest));
    expect(values[1].name).to.equal('work');
    expect(lists.normalizeDomainLists(result)).to.equal(result);
  });
  it('rejects duplicate names on create and rename, including case and Unicode normalization', () => {
    const raw = { _rulesRevision: 0, domainLists: [
      { id: 'a', name: 'Alpha', proxyId: 'p', enabled: true, domains: ['a.test'] },
      { id: 'b', name: 'Beta', proxyId: 'p', enabled: false, domains: [] },
    ] };
    const catalog = [{ id: 'p', enabled: true }];
    for (const name of ['Alpha', ' alpha ', 'Ａlpha']) {
      expect(() => lists.saveDomainList(raw, { expectedRevision: 0, name, proxyId: 'p', enabled: true }, { catalog }))
        .to.throw().with.property('code', 'DOMAIN_LIST_NAME_EXISTS');
      expect(() => lists.saveDomainList(raw, { expectedRevision: 0, listId: 'b', name }, { catalog }))
        .to.throw().with.property('code', 'DOMAIN_LIST_NAME_EXISTS');
    }
    expect(lists.saveDomainList(raw, { expectedRevision: 0, listId: 'a', name: 'ALPHA' }, { catalog }).domainLists[0].name).to.equal('ALPHA');
    expect(raw.domainLists.map(list => list.name)).to.deep.equal(['Alpha', 'Beta']);
  });
  it('tracks PAC override provenance, compact history and safe undo independently of lists', () => {
    const before = migrateSettings({ exceptions: {}, whitelist: [] });
    const after = recordRuleChange(before, { ...before, pacBypassDomains: ['PAC.test', 'pac.test'] });
    expect(after.pacBypassDomains).to.deep.equal(['pac.test']);
    expect(after._rulesRevision).to.equal(1);
    expect(after.ruleHistory[0].changes).to.deep.include({ kind: 'pac', domain: 'pac.test', before: null, after: true, beforeMeta: null });
    const restored = migrateSettings(encodeSettings(after));
    expect(restored).to.deep.equal(after);
    expect(undoRuleChange(restored).settings.pacBypassDomains).to.deep.equal([]);
    expect(serializePacMods(after)).not.to.have.property('pacBypassDomains');
    const privateLists = { ...after, domainLists: [{ id: 'a', name: 'A', proxyId: 'missing', enabled: true, domains: ['secret.test'] }] };
    expect(serializePacMods(privateLists)).not.to.have.property('domainLists');
    expect(serializePacMods(privateLists, true)).not.to.have.property('domainLists');
  });
  it('packs collections and bypass rules, reads legacy compact formats and bumps one global revision', () => {
    const previous = migrateSettings({ exceptions: { 'manual.test': true }, whitelist: [], ifUseLocalTor: true });
    const domainLists = [{ id: 'a', name: 'A', proxyId: 'builtin:tor', enabled: true, domains: ['one.test'] },
      { id: 'b', name: 'B', proxyId: 'builtin:tor', enabled: false, domains: ['one.test', '*.two.test'] }];
    const next = recordRuleChange(previous, { ...previous, domainLists });
    expect(next._rulesRevision).to.equal(previous._rulesRevision + 1);
    expect(next.ruleMeta).to.equal(previous.ruleMeta);
    clearSettingsCodecCache();
    const packed = encodeSettings(next);
    expect(packed).not.to.have.property('domainLists');
    expect(packed).not.to.have.property('pacBypassDomains');
    expect(migrateSettings(structuredClone(packed))).to.deep.equal(next);
    const legacy = JSON.parse(packed._ruleData).slice(0, 7);
    expect(decodeSettings({ _ruleData: JSON.stringify(legacy) }).domainLists).to.deep.equal([]);
    const corrupt = JSON.parse(packed._ruleData);
    corrupt[7][0].domains = [9999];
    expect(() => decodeSettings({ ...packed, _ruleData: JSON.stringify(corrupt) })).to.throw();
    expect(() => migrateSettings({ domainLists: [{ ...domainLists[0], domains: ['invalid'] }] })).to.throw();
    expect(() => migrateSettings({ domainLists: [domainLists[0], domainLists[0]] })).to.throw();
  });
  it('protects collection references on raw profile edits and replaces them atomically', () => {
    const base = reconcileProxyProfiles({ customProxyStringRaw: 'HTTP a.test:80; HTTPS b.test:443', exceptions: {} });
    const [a, b] = base.proxyProfiles;
    const raw = { ...base, domainLists: [{ id: 'a', name: 'A', proxyId: a.id, enabled: false, domains: [] }] };
    expect(() => deleteProxyProfile(raw, a.id)).to.throw().with.property('code', 'PROXY_REPLACEMENT_REQUIRED');
    const replaced = deleteProxyProfile(raw, a.id, b.id);
    expect(replaced.domainLists[0].proxyId).to.equal(b.id);
    expect(() => reconcileProxyProfiles({ ...raw, customProxyStringRaw: 'HTTPS b.test:443' }, raw)).to.throw();
    const disabled = reconcileProxyProfiles({ ...raw, ifUseSecureProxiesOnly: true }, raw);
    expect(disabled.domainLists).to.equal(raw.domainLists);
    expect(getProxyCatalog(disabled).find(profile => profile.id === a.id).enabled).to.equal(false);
    expect(reconcileProxyProfiles({ ...raw, domainLists: [{ ...raw.domainLists[0], proxyId: 'missing' }] }).domainLists[0].proxyId).to.equal('missing');
  });
  it('creates normalized independent collections without touching manual rules', () => {
    const values = Array.from({ length: 60000 }, (_, i) => `host-${i}.test`);
    const list = { id: 'a', name: 'A', proxyId: 'p', enabled: true, domains: values };
    expect(() => lists.normalizeDomainLists([list, { ...list, id: 'b', domains: values.slice(0, 40001) }])).to.throw();
    expect(lists.normalizeDomainLists([list, { ...list, id: 'b', domains: values.slice(0, 40000) }])[1].domains).to.have.length(40000);
    const empty = { ...list, domains: [] };
    expect(lists.normalizeDomainLists(Array.from({ length: 100 }, (_, id) => ({ ...empty, id: String(id) })))).to.have.length(100);
    expect(() => lists.normalizeDomainLists(Array.from({ length: 101 }, (_, id) => ({ ...empty, id: String(id) })))).to.throw();
    expect(lists.normalizeDomainLists, 'canonical validation').to.be.a('function');
    expect(lists.saveDomainList, 'save list').to.be.a('function');
    const raw = { _rulesRevision: 3, exceptions: { 'manual.test': false }, domainProxyIds: {}, ruleMeta: {} };
    const catalog = [{ id: 'p', enabled: true }];
    const first = lists.saveDomainList(raw, { expectedRevision: 3, name: '  Ａ  ', proxyId: 'p', enabled: true,
      domains: ['EXAMPLE.test', 'example.test', '*.other.test'] }, { catalog });
    expect(first.domainLists[0]).to.include({ name: 'A', proxyId: 'p', enabled: true });
    expect(first.domainLists[0].id).to.match(/^list:[\da-f-]{36}$/);
    expect(first.domainLists[0].domains).to.deep.equal(['example.test', '*.other.test']);
    const second = lists.saveDomainList(first, { expectedRevision: 3, name: 'B', proxyId: 'p', enabled: false,
      domains: ['example.test'] }, { catalog });
    expect(second.domainLists).to.have.length(2);
    expect(second.domainLists[0]).to.equal(first.domainLists[0]);
    expect(second.domainLists[1].domains).to.deep.equal(['example.test']);
    expect(second.exceptions).to.equal(raw.exceptions);
    expect(second.domainProxyIds).to.equal(raw.domainProxyIds);
    expect(second.ruleMeta).to.equal(raw.ruleMeta);
    expect(() => lists.saveDomainList(raw, { name: 'X' }, { catalog })).to.throw().with.property('code', 'RULES_REVISION_REQUIRED');
    expect(() => lists.saveDomainList(raw, { expectedRevision: 2, name: 'X' }, { catalog })).to.throw().with.property('code', 'RULES_CONFLICT');
    expect(() => lists.saveDomainList(first, { expectedRevision: 3, listId: 'unknown' }, { catalog })).to.throw().with.property('code', 'DOMAIN_LIST_UNKNOWN');
  });
  it('preserves list identities on hydration and tracks list/profile/reorder changes without fake undo entries', () => {
    const raw = migrateSettings({ customProxyStringRaw: 'HTTPS a.test:443; HTTPS b.test:443', exceptions: {}, whitelist: [] });
    const [a, b] = raw.proxyProfiles;
    const next = recordRuleChange(raw, lists.saveDomainList(raw, { expectedRevision: 0, name: 'A', proxyId: a.id, enabled: true,
      domains: ['one.test'] }, { catalog: getProxyCatalog(raw) }));
    expect(next._rulesRevision).to.equal(1);
    expect(next.ruleHistory).to.equal(raw.ruleHistory);
    expect(next.ruleMeta).to.equal(raw.ruleMeta);
    const hydrated = migrateSettings(next);
    expect(hydrated.domainLists).to.equal(next.domainLists);
    expect(recordRuleChange(next, hydrated)._rulesRevision).to.equal(1);
    const replaced = recordRuleChange(next, deleteProxyProfile(next, a.id, b.id));
    expect(replaced._rulesRevision).to.equal(2);
    expect(replaced.ruleHistory).to.equal(next.ruleHistory);
    expect(replaced.domainLists[0].proxyId).to.equal(b.id);
    const renamed = recordRuleChange(replaced, { ...replaced, proxyProfiles: replaced.proxyProfiles.map(profile => ({ ...profile, name: 'Name' })) });
    expect(renamed.domainLists).to.equal(replaced.domainLists);
    expect(renamed._rulesRevision).to.equal(2);
    const second = recordRuleChange(renamed, lists.saveDomainList(renamed, { expectedRevision: 2, name: 'B', proxyId: b.id, enabled: false }, { catalog: getProxyCatalog(renamed) }));
    const reversed = recordRuleChange(second, lists.reorderDomainLists(second, { expectedRevision: 3,
      listIds: second.domainLists.map(list => list.id).reverse() }));
    expect(reversed._rulesRevision).to.equal(4);
    expect(reversed.ruleHistory).to.equal(next.ruleHistory);
  });
  it('matches an upper wildcard before a lower exact rule and retains unavailable IDs', () => {
    expect(lists.matchDomainLists, 'domain list matcher').to.be.a('function');
    const snapshot = [
      { id: 'upper', enabled: true, proxyId: 'missing', domains: ['*.example.test'] },
      { id: 'lower', enabled: true, proxyId: 'other', domains: ['a.example.test'] },
    ];
    expect(lists.matchDomainLists('a.example.test', snapshot)).to.deep.equal({
      matched: true, isProxied: true, ruleKey: '*.example.test', proxyId: 'missing', listId: 'upper',
    });
    expect(lists.matchDomainLists('a.example.test', [{ ...snapshot[0], enabled: false }, snapshot[1]]).listId).to.equal('lower');
    expect(lists.matchDomainLists('other.test', snapshot)).to.deep.equal({ matched: false });
  });
  it('updates latest fields, preserves unavailable bindings and rejects bad rows atomically', () => {
    const raw = { _rulesRevision: 5, domainLists: [{ id: 'a', name: 'A', proxyId: 'gone', enabled: true, domains: ['old.test'] }] };
    const update = patch => lists.saveDomainList(raw, { listId: 'a', expectedRevision: 5, ...patch });
    expect(update({ name: 'B', domains: ['new.test'], enabled: false }).domainLists[0])
      .to.deep.equal({ id: 'a', name: 'B', proxyId: 'gone', enabled: false, domains: ['new.test'] });
    expect(update({ proxyId: 'gone' })).to.equal(raw);
    const disabled = { ...raw, domainLists: [{ ...raw.domainLists[0], enabled: false }] };
    expect(() => lists.saveDomainList(disabled, { listId: 'a', enabled: true, expectedRevision: 5 })).to.throw().with.property('code', 'PROXY_TARGET_UNAVAILABLE');
    expect(() => update({ proxyId: 'other' })).to.throw().with.property('code', 'PROXY_TARGET_UNAVAILABLE');
    for (const domains of [['valid.test', 'invalid'], ['valid.test', null], 'a.test']) expect(() => update({ domains })).to.throw();
    expect(raw.domainLists[0].domains).to.deep.equal(['old.test']);
    for (const name of ['', 'x'.repeat(65), '😀'.repeat(65), 'a\u0000b']) expect(() => update({ name })).to.throw();
    expect(update({ name: '😀'.repeat(64) }).domainLists[0].name).to.equal('😀'.repeat(64));
  });
  it('requires an exact permutation on reorder and rejects unknown deletion', () => {
    expect(lists.reorderDomainLists, 'reorder').to.be.a('function');
    const raw = { _rulesRevision: 0, domainLists: [{ id: 'a' }, { id: 'b' }] };
    expect(lists.reorderDomainLists(raw, { listIds: ['b', 'a'], expectedRevision: 0 }).domainLists.map(item => item.id)).to.deep.equal(['b', 'a']);
    expect(lists.reorderDomainLists(raw, { listIds: ['a', 'b'], expectedRevision: 0 })).to.equal(raw);
    for (const listIds of [['a'], ['a', 'a'], ['a', 'unknown'], ['a', 'b', 'b']]) {
      expect(() => lists.reorderDomainLists(raw, { listIds, expectedRevision: 0 })).to.throw();
    }
    expect(lists.deleteDomainList(raw, { listId: 'a', expectedRevision: 0 }).domainLists).to.deep.equal([{ id: 'b' }]);
    expect(() => lists.deleteDomainList(raw, { listId: 'unknown', expectedRevision: 0 })).to.throw();
    expect(() => lists.deleteDomainList(raw, { listId: 'a' })).to.throw().with.property('code', 'RULES_REVISION_REQUIRED');
  });
});

describe('Domain list RPC persistence', () => {
  let listener;
  let original;
  beforeEach(() => {
    original = { chrome: globalThis.chrome, local: appState.ensureLocalStateInitialized,
      apply: settingsCoordinator.apply, state: settingsCoordinator.state };
    const data = {};
    globalThis.chrome = { runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`,
      onMessage: { addListener: callback => { listener = callback; } } }, storage: { local: {
      get: (key, callback) => callback({ [key]: data[key] }),
      set: (items, callback) => { Object.assign(data, items); callback(); },
      remove: (keys, callback) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; callback(); },
    } } };
    appState.ensureLocalStateInitialized = async () => {};
    settingsCoordinator.apply = async () => ({ pending: false });
    settingsCoordinator.state = async () => ({ pending: false });
    pacKitchen.invalidateCache();
    setupMessageBus();
  });
  afterEach(() => {
    globalThis.chrome = original.chrome;
    appState.ensureLocalStateInitialized = original.local;
    settingsCoordinator.apply = original.apply;
    settingsCoordinator.state = original.state;
    pacKitchen.invalidateCache();
  });
  const send = message => new Promise(resolve => listener(message, { id: 'test', url: 'chrome-extension://test/pages/options/index.html' }, resolve));
  it('serializes create/update/reorder/delete with global conflicts and metadata-only retrieval', async () => {
    await pacKitchen.updatePacMods(raw => ({ ...raw, ifUseLocalTor: true }));
    const first = await send({ action: 'GET_DOMAIN_LISTS' });
    expect(first.success, first.error).to.equal(true);
    expect(first.data.lists).to.deep.equal([]);
    const create = name => ({ action: 'SAVE_DOMAIN_LIST', name, proxyId: 'builtin:tor', enabled: true,
      domains: ['one.test'], expectedRevision: first.data.revision });
    const results = await Promise.all([send(create('One')), send(create('Two'))]);
    expect(results.filter(result => result.success)).to.have.length(1);
    expect(results.find(result => !result.success).errorCode).to.equal('RULES_CONFLICT');
    const metadata = await send({ action: 'GET_DOMAIN_LISTS' });
    const id = metadata.data.lists[0].id;
    expect(metadata.data.lists[0]).to.deep.equal({ id, name: 'One', proxyId: 'builtin:tor', enabled: true, count: 1 });
    const duplicate = await send({ ...create(' one '), expectedRevision: metadata.data.revision });
    expect(duplicate).to.include({ success: false, errorCode: 'DOMAIN_LIST_NAME_EXISTS' });
    expect(duplicate.error).to.match(/уже существует|already exists/);
    expect((await pacKitchen.getRawPacMods()).domainLists).to.have.length(1);
    const detail = await send({ action: 'GET_DOMAIN_LIST', listId: id });
    expect(detail.data.list.domains).to.deep.equal(['one.test']);
    expect(detail).to.have.property('settingsState');
    const before = await pacKitchen.getRawPacMods();
    const packed = await storage.get('pac-kitchen-mods');
    expect(packed).not.to.have.property('domainLists');
    expect((await send({ action: 'SAVE_DOMAIN_LIST', listId: id, domains: ['valid.test', 'invalid'], expectedRevision: metadata.data.revision })).success).to.equal(false);
    expect(await pacKitchen.getRawPacMods()).to.equal(before);
    expect((await send({ action: 'SAVE_DOMAIN_LIST', listId: id, name: 'Renamed', expectedRevision: metadata.data.revision })).success).to.equal(true);
    let latest = await send({ action: 'GET_DOMAIN_LISTS' });
    expect((await send({ action: 'REORDER_DOMAIN_LISTS', listIds: [id], expectedRevision: latest.data.revision })).success).to.equal(true);
    expect((await send({ action: 'GET_DOMAIN_LISTS' })).data.revision).to.equal(latest.data.revision);
    expect((await send({ action: 'SAVE_MODS', mods: { ifProxyOrDie: false } })).success).to.equal(true);
    pacKitchen.invalidateCache();
    expect((await pacKitchen.getRawPacMods()).domainLists[0].name).to.equal('Renamed');
    latest = await send({ action: 'GET_DOMAIN_LISTS' });
    expect((await send({ action: 'DELETE_DOMAIN_LIST', listId: id, expectedRevision: latest.data.revision })).success).to.equal(true);
    expect((await send({ action: 'GET_DOMAIN_LISTS' })).data.lists).to.deep.equal([]);
    expect((await send({ action: 'GET_DOMAIN_LIST', listId: id })).success).to.equal(false);
    const manual = await send({ action: 'GET_EXCEPTIONS' });
    expect(manual.data.pacBypassDomains).to.deep.equal([]);
    expect((await send({ action: 'GET_EXCEPTIONS', knownRevision: manual.data.revision })).data).not.to.have.property('pacBypassDomains');
    const pacWrite = await send({ action: 'SAVE_MODS', mods: { pacBypassDomains: ['pac.test'] }, expectedRevision: manual.data.revision });
    expect(pacWrite.success, pacWrite.error).to.equal(true);
    const afterPac = await send({ action: 'GET_EXCEPTIONS' });
    expect(afterPac.data.pacBypassDomains).to.deep.equal(['pac.test']);
    expect(afterPac.data.revision).to.equal(manual.data.revision + 1);
    expect((await send({ action: 'SAVE_MODS', mods: { pacBypassDomains: [] } })).errorCode).to.equal('RULES_REVISION_REQUIRED');
    expect((await pacKitchen.getRawPacMods()).ruleMeta['pac:pac.test'].source).to.equal('manual');
  });
});
