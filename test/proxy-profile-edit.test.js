import { strict as assert } from 'node:assert';
import * as profiles from '../src/common/core/proxy-profiles.js';
import { buildProxyCredentialsMap } from '../src/common/core/proxy-auth.js';
import { parseCustomProxies } from '../src/common/core/utils.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';
import { recordRuleChange } from '../src/common/core/settings-schema.js';
const setup = () => profiles.reconcileProxyProfiles({ customProxyStringRaw: 'HTTPS user:old@a.test:443; HTTPS b.test:443', exceptions: { 'site.test': true } });

describe('proxy connection edits', () => {
  it('changes the connection atomically without moving any stable bindings', () => {
    let base = setup();
    const [a, b] = base.proxyProfiles;
    base = { ...base, domainProxyIds: { 'site.test': a.id }, domainLists: [{ id: 'list', proxyId: a.id }], fallbackProxyId: a.id };
    const edited = profiles.updateProxyProfile(base, a.id, { proxy: 'HTTP new:password@c.test:8080', name: 'Edited' });
    assert.deepEqual(edited.proxyProfiles.map(p => p.id), [a.id, b.id]);
    assert.deepEqual(edited.proxyProfiles[0], { id: a.id, name: 'Edited', endpoint: 'PROXY c.test:8080' });
    assert.equal(edited.domainProxyIds, base.domainProxyIds);
    assert.equal(edited.domainLists, base.domainLists);
    assert.equal(edited.defaultProxyId, a.id);
    assert.equal(edited.fallbackProxyId, a.id);
    assert.equal(edited.customProxyStringRaw, 'HTTP new:password@c.test:8080; HTTPS b.test:443');
    assert.equal(profiles.compileProxyRoutes(edited)[a.id], 'PROXY c.test:8080');
    assert.equal(base.customProxyStringRaw, 'HTTPS user:old@a.test:443; HTTPS b.test:443');
  });
  it('survives the save pipeline second reconciliation without allowing forged identity moves', () => {
    const base = setup(); const id = base.proxyProfiles[0].id;
    const edited = profiles.updateProxyProfile(base, id, { proxy: 'HTTPS c.test:443', name: 'Changed' });
    const recorded = recordRuleChange(base, { ...edited }, {});
    assert.equal(recorded.proxyProfiles[0].id, id);
    assert.equal(recorded.proxyProfiles[0].endpoint, 'HTTPS c.test:443');
  });
  it('preserves unrelated raw whitespace, comments, and legacy invalid entries', () => {
    const base = profiles.reconcileProxyProfiles({ customProxyStringRaw: '  HTTPS a.test:443 # first\n\n BROKEN saved ;  HTTPS b.test:443 # second\n' });
    const next = profiles.updateProxyProfile(base, base.proxyProfiles[0].id, { proxy: 'HTTPS c.test:443' });
    assert.equal(next.customProxyStringRaw, '  HTTPS c.test:443 # first\n\n BROKEN saved ;  HTTPS b.test:443 # second\n');
  });
  it('shares raw hash and line-comment rules across profiles, display, and credentials', () => {
    const raw = 'HTTPS user:p#ss@a.test:443; HTTPS b.test:443 # note; PROXY ignored.test:80\r\n;# comment\r\nHTTPS c.test:443';
    const base = profiles.reconcileProxyProfiles({ customProxyStringRaw: raw });
    const normalized = raw.replace('p#ss', 'p%23ss');
    assert.equal(base.customProxyStringRaw, normalized);
    assert.deepEqual(base.proxyProfiles.map(p => p.endpoint), ['HTTPS a.test:443', 'HTTPS b.test:443', 'HTTPS c.test:443']);
    assert.deepEqual(parseCustomProxies(raw).map(p => p.password), ['p#ss', '', '']);
    assert.deepEqual(buildProxyCredentialsMap(raw), { 'a.test:443': { username: 'user', password: 'p#ss' } });
    const [error, cooked] = createPacModifiers(base);
    assert.ifError(error);
    assert.deepEqual(cooked.customProxyArray, ['HTTPS a.test:443', 'HTTPS b.test:443', 'HTTPS c.test:443']);
    const edited = profiles.updateProxyProfile(base, base.proxyProfiles[0].id, { proxy: 'HTTPS user:new#secret@a.test:443' });
    assert.equal(edited.customProxyStringRaw, normalized.replace('p%23ss', 'new%23secret'));
    assert.throws(() => profiles.updateProxyProfile(base, base.proxyProfiles[0].id, { proxy: 'HTTPS a.test:443 # annotation' }), { code: 'PROXY_INVALID_ENDPOINT' });
  });
  it('deletes a proxy without rewriting comments, line endings, or legacy entries', () => {
    const raw = '# heading; PROXY ignored.test:80\r\n  HTTPS user:p#ss@a.test:443 # keep note; HTTPS a.test:443\r\n\r\n  BROKEN legacy ;  HTTPS b.test:443\r\n';
    const base = profiles.reconcileProxyProfiles({ customProxyStringRaw: raw });
    const [a, b] = base.proxyProfiles;
    const deleted = profiles.deleteProxyProfile(base, a.id, b.id);
    assert.equal(deleted.customProxyStringRaw, base.customProxyStringRaw.replace('HTTPS user:p%23ss@a.test:443', ''));
    assert.deepEqual(deleted.proxyProfiles, [b]);
    assert.equal(deleted.defaultProxyId, b.id);
  });
  it('updates auth with an unchanged catalog, preserves legacy names, and rejects unsafe edits', () => {
    const initial = setup();
    const base = { ...initial, proxyProfiles: initial.proxyProfiles.map((p, i) => i ? p : { ...p, name: 'x'.repeat(80) }) };
    const a = base.proxyProfiles[0];
    const next = profiles.updateProxyProfile(base, a.id, { proxy: 'HTTPS user:new%20password@a.test:443', name: a.name });
    assert.equal(next.customProxyStringRaw, 'HTTPS user:new%20password@a.test:443; HTTPS b.test:443');
    assert.equal(next.proxyProfiles, base.proxyProfiles);
    assert.equal(profiles.updateProxyProfile(base, a.id, { proxy: 'HTTPS c.test:443', name: a.name }).proxyProfiles[0].name, a.name);
    assert.throws(() => profiles.renameProxyProfile(base, a.id, a.name), { code: 'PROXY_INVALID_NAME' });
    for (const [proxy, code] of [
      ['HTTPS b.test:443', 'PROXY_DUPLICATE_ENDPOINT'], ['BROKEN a', 'PROXY_INVALID_ENDPOINT'],
      ['SOCKS5 user:secret@a.test:1080', 'PROXY_SOCKS_AUTH'], ['HTTP different:secret@b.test:443', 'PROXY_AUTH_CONFLICT'],
      ['HTTPS a.test:443; HTTPS c.test:443', 'PROXY_INVALID_ENDPOINT'],
    ]) assert.throws(() => profiles.updateProxyProfile(base, a.id, { proxy }), { code });
    for (const name of ['Tor', base.proxyProfiles[1].name, 'z'.repeat(33)]) assert.throws(() => profiles.updateProxyProfile(base, a.id, { proxy: 'HTTPS c.test:443', name }));
    assert.throws(() => profiles.updateProxyProfile(base, 'builtin:tor', { proxy: 'HTTP a.test:80' }), { code: 'PROXY_BUILTIN_READONLY' });
    assert.throws(() => profiles.updateProxyProfile(base, 'missing', {}), { code: 'PROXY_UNKNOWN_ID' });
    assert.throws(() => profiles.reconcileProxyProfiles({ ...base, customProxyStringRaw: 'HTTPS c.test:443; HTTPS b.test:443', proxyProfiles: base.proxyProfiles.map((p, i) => i ? p : { ...p, endpoint: 'HTTPS c.test:443' }) }, base), { code: 'PROXY_INVALID_ID' });
  });
});
