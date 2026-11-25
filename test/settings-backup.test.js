import { expect } from 'chai';
import { fitsBackupByteLimit } from '../src/common/core/settings-backup-size.js';
const backup = await import('../src/common/core/settings-backup.js').catch(() => ({}));

const ID = 'custom:11111111-1111-4111-8111-111111111111';
const PAC = 'function FindProxyForURL(url, host) { return "DIRECT"; }';
export function fixture() {
  return {
    settings: { customProxyStringRaw: 'HTTPS user:%20p%40ss%20@proxy.test:443',
      proxyProfiles: [{ id: ID, name: 'Private proxy', endpoint: 'HTTPS proxy.test:443' }],
      defaultProxyId: ID, fallbackProxyId: null,
      exceptions: { 'example.test': true }, domainProxyIds: { 'example.test': ID },
      whitelist: ['example.test'], pacBypassDomains: ['direct.test'],
      domainLists: [{ id: 'list:one', name: 'Work', proxyId: ID, enabled: false, domains: ['*.work.test'] }],
      siteResourceInheritance: { 'example.com': false },
      ifUseLocalTor: false, ifUseLocalWarp: true, ifProxyOrDie: false },
    pac: { currentPacProviderKey: 'customPacUrl', customPacUrl: 'https://pac.test/custom.pac', rawPacData: PAC },
    notifications: { 'pac-error': false, 'ext-error': true, 'no-control': false },
    appearance: { theme: 'dark', accent: 'custom', customColor: '#123456' },
  };
}

describe('Portable settings JSON', () => {
  it('measures UTF-8 at the exact byte boundary, including surrogate pairs and replacement characters', () => {
    const encoder = new TextEncoder();
    for (const text of ['a', 'é', '雪', '🚀', '\ud800', '\udc00', '雪🚀éa\ud800']) {
      const size = encoder.encode(text).length;
      expect(fitsBackupByteLimit(text, size)).to.equal(true);
      expect(fitsBackupByteLimit(text, size - 1)).to.equal(false);
    }
  });

  it('validates JSON text without serializing or cloning the newly parsed backup', () => {
    const input = JSON.stringify(backup.createSettingsBackup(fixture()));
    const stringify = JSON.stringify, clone = globalThis.structuredClone;
    let fullCopies = 0;
    const count = fn => (value, ...args) => {
      if (value?.format === backup.BACKUP_FORMAT) fullCopies++;
      return fn(value, ...args);
    };
    JSON.stringify = count(stringify);
    globalThis.structuredClone = count(clone);
    try {
      expect(backup.validateSettingsBackup(input).pac.rawPacData).to.equal(PAC);
      expect(fullCopies).to.equal(0);
    } finally { JSON.stringify = stringify; globalThis.structuredClone = clone; }
  });

  it('rejects malformed, future, dangerous, oversized and mistyped data without exposing secrets', () => {
    expect(backup.validateSettingsBackup).to.be.a('function');
    const mutations = [
      b => { b.formatVersion = 2; }, b => { b.settings.ifProxyOrDie = 'false'; },
      b => { b.settings.fallbackProxyId = 'missing'; }, b => { b.settings.exceptions['bad domain!'] = true; },
      b => { b.settings.domainProxyIds['example.test'] = 'missing'; },
      b => { b.settings.domainLists[0].domains = ['bad domain!']; },
      b => { b.settings.domainLists[0].enabled = 1; },
      b => { b.settings.proxyProfiles[0].endpoint = 'HTTPS other.test:443'; },
      b => { b.settings.proxyProfiles[0].id = 'invalid'; },
      b => { b.settings.whitelist = Array(100001).fill('example.test'); },
      b => { b.settings.siteResourceInheritance = { 'not a domain': false }; },
      b => { b.notifications['pac-error'] = 0; }, b => { b.appearance.theme = 'arbitrary'; },
      b => { b.pac.rawPacData = 'not a PAC'; }, b => { b.pac.currentPacProviderKey = 'unknown'; },
      b => { b.pac.customPacUrl = 'javascript:secret'; },
      b => { b.settings.customProxyStringRaw = 'HTTPS fixture-secret@bad:99999'; },
      b => { b.settings.ruleMeta = { 'exception:example.test': { source: 'bogus', revision: 1 } }; },
    ];
    for (const mutate of mutations) {
      const input = backup.createSettingsBackup(fixture()); mutate(input);
      let error; try { backup.validateSettingsBackup(JSON.stringify(input)); } catch (e) { error = e; }
      expect(error, mutate.toString()).to.be.an('error');
      expect(error.message).not.to.match(/fixture-secret|%20p%40ss/);
    }
    for (const input of ['{secret-broken', '{"__proto__":{"polluted":true}}', '{"constructor":{}}']) {
      expect(() => backup.validateSettingsBackup(input)).to.throw().with.property('code', 'BACKUP_INVALID');
    }
  });
  it('localizes backend errors and exported warnings without exposing credential-bearing causes', () => {
    expect(backup.backupErrorMessage).to.be.a('function');
    const original = globalThis.chrome;
    globalThis.chrome = { ...(original || {}), i18n: { getMessage: key => ({
      backup_error_invalid: 'Invalid or unsupported settings file.',
      backup_error_storage_failed: 'Could not save the import. Previous settings were restored.',
      portable_settings_warning: 'Warning: JSON contains all proxy passwords.',
    })[key] || '' } };
    try {
      expect(() => backup.validateSettingsBackup('{fixture-secret')).to.throw('Invalid or unsupported settings file.');
      expect(backup.backupErrorMessage('BACKUP_STORAGE_FAILED')).to.equal('Could not save the import. Previous settings were restored.');
      expect(backup.createSettingsBackup(fixture()).warning).to.equal('Warning: JSON contains all proxy passwords.');
    } finally { globalThis.chrome = original; }
  });
  it('preserves unchanged legacy profile names above the new-profile name limit', () => {
    const input = fixture(); input.settings.proxyProfiles[0].name = '  ' + 'L'.repeat(60) + '  ';
    const restored = backup.validateSettingsBackup(backup.createSettingsBackup(input));
    expect(restored.settings.proxyProfiles[0].name).to.equal(input.settings.proxyProfiles[0].name);
  });
  it('includes grandfathered over-limit catalogs instead of dropping profiles during a portable restore', () => {
    const input = fixture();
    input.settings.proxyProfiles = Array.from({ length: 56 }, (_, i) => ({ id: `custom:11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
      name: `Legacy ${i}`, endpoint: `HTTPS fixture${i}.test:443` }));
    input.settings.customProxyStringRaw = input.settings.proxyProfiles.map(p => p.endpoint).join(';\n');
    input.settings.defaultProxyId = input.settings.proxyProfiles[0].id;
    input.settings.domainProxyIds['example.test'] = input.settings.proxyProfiles[0].id;
    input.settings.domainLists[0].proxyId = input.settings.proxyProfiles[55].id;
    const restored = backup.validateSettingsBackup(backup.createSettingsBackup(input));
    expect(restored.settings.proxyProfiles).to.deep.equal(input.settings.proxyProfiles);
  });
  it('preserves encoded and edge whitespace password source text, nullable fallback and disabled bindings', () => {
    const input = fixture(); input.settings.customProxyStringRaw = '  HTTPS user:%20%09pass%2520%40%3A%23@proxy.test:443  \n';
    input.settings.fallbackProxyId = ID; input.settings.ifUseSecureProxiesOnly = true;
    const restored = backup.validateSettingsBackup(JSON.stringify(backup.createSettingsBackup(input)));
    expect(restored.settings.customProxyStringRaw).to.equal(input.settings.customProxyStringRaw);
    expect(restored.settings.fallbackProxyId).to.equal(ID);
    const legacy = backup.createSettingsBackup(fixture()); legacy.formatVersion = 0;
    delete legacy.settings.fallbackProxyId;
    expect(backup.validateSettingsBackup(legacy).settings.fallbackProxyId).to.equal(null);
  });
  it('round-trips complete user settings including verbatim fixture passwords and list content', () => {
    expect(backup.createSettingsBackup).to.be.a('function');
    const input = fixture();
    const exported = backup.createSettingsBackup(input);
    const restored = backup.validateSettingsBackup(JSON.stringify(exported));
    for (const key of ['pac', 'notifications', 'appearance']) expect(restored[key]).to.deep.equal(input[key]);
    for (const [key, value] of Object.entries(input.settings)) expect(restored.settings[key]).to.deep.equal(value);
    expect(restored.settings).to.have.property('ifProxyHttpsUrlsOnly', false);
    expect(restored.settings).to.have.property('ifMindExceptions', true);
    expect(exported).to.include({ format: 'unroute-settings', formatVersion: 1, includesPasswords: true });
    expect(exported.warning).to.match(/password|парол/i);
    expect(JSON.stringify(exported)).not.to.include('_ruleData');
  });
});
