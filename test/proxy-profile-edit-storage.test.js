import { strict as assert } from 'node:assert';
import { storage } from '../src/common/core/storage.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { encodeSettings, decodeSettings } from '../src/common/core/settings-codec.js';
import { updateProxyProfile } from '../src/common/core/proxy-profiles.js';
import { buildProxyCredentialsMap, getPersistentCredentialsMap, commitProxyCredentials } from '../src/common/core/proxy-auth.js';

describe('connection edit persist-first pipeline with synthetic storage', () => {
  let original; let saved; let credentials;
  beforeEach(() => {
    original = { get: storage.get, set: storage.set, remove: storage.remove };
    credentials = getPersistentCredentialsMap();
    saved = encodeSettings({ exceptions: {}, whitelist: [], customProxyStringRaw: 'HTTPS user:old@a.test:443' });
    storage.get = async (key, fallback) => key === 'pac-kitchen-mods' ? structuredClone(saved) : fallback;
    storage.set = async (key, value) => { if (key === 'pac-kitchen-mods') saved = structuredClone(value); };
    storage.remove = async () => {};
    pacKitchen.invalidateCache();
  });
  afterEach(() => { Object.assign(storage, original); pacKitchen.invalidateCache(); commitProxyCredentials(credentials); });
  it('commits credentials-only edits even when catalog and routes are unchanged', async () => {
    const base = await pacKitchen.getRawPacMods();
    await pacKitchen.getPacMods();
    const proxy = 'HTTPS user:%20new%20password%20@a.test:443';
    await pacKitchen.updatePacMods(raw => updateProxyProfile(raw, base.proxyProfiles[0].id, { proxy }), { preferencesOnly: true });
    assert.equal(decodeSettings(saved).customProxyStringRaw, proxy);
    assert.deepEqual(getPersistentCredentialsMap(), buildProxyCredentialsMap(proxy));
    assert.deepEqual((await pacKitchen.getRawPacMods()).proxyProfiles, base.proxyProfiles);
  });
  it('persists endpoint edits through double reconciliation, retaining stable identity', async () => {
    const base = await pacKitchen.getRawPacMods();
    await pacKitchen.updatePacMods(raw => updateProxyProfile(raw, base.proxyProfiles[0].id, { proxy: 'HTTP next:password@c.test:8080' }), { preferencesOnly: true });
    assert.equal(decodeSettings(saved).proxyProfiles[0].id, base.proxyProfiles[0].id);
    assert.equal(decodeSettings(saved).proxyProfiles[0].endpoint, 'PROXY c.test:8080');
  });
});
