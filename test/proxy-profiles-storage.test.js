import { expect } from 'chai';
import { storage } from '../src/common/core/storage.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { encodeSettings, decodeSettings } from '../src/common/core/settings-codec.js';
import { renameProxyProfile } from '../src/common/core/proxy-profiles.js';
import { migrateSettings } from '../src/common/core/settings-schema.js';

describe('Proxy profiles persist-first migration', () => {
  let original; let saved; let writes;
  beforeEach(() => {
    original = { get: storage.get, set: storage.set, remove: storage.remove };
    saved = encodeSettings({ exceptions: { 'site.test': true }, whitelist: [], customProxyStringRaw: 'HTTPS a.test:443' });
    writes = 0;
    storage.get = async (key, fallback) => key === 'pac-kitchen-mods' ? structuredClone(saved) : fallback;
    storage.set = async (key, value) => { if (key === 'pac-kitchen-mods') { writes++; saved = structuredClone(value); } };
    storage.remove = async () => {};
    pacKitchen.invalidateCache();
  });
  afterEach(() => { Object.assign(storage, original); pacKitchen.invalidateCache(); });
  it('persists generated IDs even for compact legacy snapshots and does not rewrite on cold reload', async () => {
    const first = await pacKitchen.getRawPacMods();
    expect(writes).to.equal(1);
    expect(saved.proxyProfiles[0].id).to.equal(first.proxyProfiles[0].id);
    expect(first.domainProxyIds).to.deep.equal({});
    pacKitchen.invalidateCache();
    const second = await pacKitchen.getRawPacMods();
    expect(second.proxyProfiles).to.deep.equal(first.proxyProfiles);
    expect(writes).to.equal(1);
  });
  it('revalidates a migrated compact import against the current count before persistence', async () => {
    const before = await pacKitchen.getRawPacMods();
    const parsed = await pacKitchen.getPacMods();
    const stored = structuredClone(saved);
    const beforeWrites = writes;
    // Migration/codec reads intentionally accept old oversized backups. They
    // must not turn into permission to grow the live catalog on save.
    const imported = migrateSettings(encodeSettings({ exceptions: {}, whitelist: [],
      customProxyStringRaw: Array.from({ length: 51 }, (_, i) => `HTTPS p${i}.test:443`).join('; ') }));
    expect(imported.proxyProfiles).to.have.length(51);
    const error = await pacKitchen.savePacMods(imported, { source: 'import' }).catch(error => error);
    expect(error).to.have.property('code', 'PROXY_LIMIT');
    expect(writes).to.equal(beforeWrites);
    expect(saved).to.deep.equal(stored);
    expect(await pacKitchen.getRawPacMods()).to.equal(before);
    expect(await pacKitchen.getPacMods()).to.equal(parsed);
  });
  it('cold-loads an oversized catalog intact and ratchets the allowance from 56 to 55', async () => {
    saved = encodeSettings({ exceptions: {}, whitelist: [],
      customProxyStringRaw: Array.from({ length: 56 }, (_, i) => `HTTPS p${i}.test:443`).join('; ') });
    const loaded = await pacKitchen.getRawPacMods();
    expect(loaded.proxyProfiles).to.have.length(56);
    const reducedRaw = loaded.customProxyStringRaw.split('; ').slice(0, 55).join('; ');
    await pacKitchen.updatePacMods(raw => ({ ...raw, customProxyStringRaw: reducedRaw }));
    pacKitchen.invalidateCache();
    const reduced = await pacKitchen.getRawPacMods();
    expect(reduced.proxyProfiles).to.have.length(55);
    expect(reduced.proxyProfiles).to.deep.equal(loaded.proxyProfiles.slice(0, 55));
    const beforeWrites = writes;
    const error = await pacKitchen.updatePacMods(raw => ({ ...raw,
      customProxyStringRaw: `${raw.customProxyStringRaw}; HTTPS new.test:443` })).catch(error => error);
    expect(error).to.have.property('code', 'PROXY_LIMIT');
    expect(writes).to.equal(beforeWrites);
    expect(await pacKitchen.getRawPacMods()).to.equal(reduced);
  });
  it('does not expose IDs or routes after failed migration and retries the real write', async () => {
    const set = storage.set;
    storage.set = async () => { throw new Error('quota'); };
    expect(await pacKitchen.getRawPacMods().catch(e => e)).to.have.property('message', 'quota');
    expect(pacKitchen.getCachedMods()).to.equal(null);
    expect(saved).not.to.have.property('proxyProfiles');
    storage.set = set;
    const raw = await pacKitchen.getRawPacMods();
    expect(raw.proxyProfiles).to.deep.equal(saved.proxyProfiles);
  });
  it('shares a pending migration with queued mutations without deadlocking', async () => {
    const [a, b] = await Promise.all([pacKitchen.getRawPacMods(), pacKitchen.updatePacMods(raw => ({ ...raw, ifProxyOrDie: false }), { preferencesOnly: true })]);
    expect(b.proxyProfiles[0].id).to.equal(a.proxyProfiles[0].id);
    expect(decodeSettings(saved).ifProxyOrDie).to.equal(false);
  });
  it('persists a metadata-only rename without changing rules or application revisions', async () => {
    const before = await pacKitchen.getRawPacMods();
    await pacKitchen.updatePacMods(raw => renameProxyProfile(raw, raw.proxyProfiles[0].id, 'Primary'), { metadataOnly: true, copyOnWrite: true });
    const after = await pacKitchen.getRawPacMods();
    expect(after._revision).to.equal(before._revision);
    expect(after._rulesRevision).to.equal(before._rulesRevision);
    expect(after._proxyCatalogRevision).to.equal(before._proxyCatalogRevision + 1);
    expect(after.exceptions).to.equal(before.exceptions);
    expect(after.domainProxyIds).to.equal(before.domainProxyIds);
    expect(saved.proxyProfiles[0].name).to.equal('Primary');
  });
});
