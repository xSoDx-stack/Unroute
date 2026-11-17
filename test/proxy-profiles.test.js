import { expect } from 'chai';
import * as profiles from '../src/common/core/proxy-profiles.js';
const setup = raw => profiles.reconcileProxyProfiles({ customProxyStringRaw: raw, exceptions: { 'site.test': true } });

describe('Proxy profile catalog', () => {
  it('limits renamed names to 32 normalized Unicode code points', () => {
    const base = setup('HTTPS a.test:443');
    const id = base.proxyProfiles[0].id;
    for (const name of ['x'.repeat(32), '😀'.repeat(32), `  ${'Ａ'.repeat(32)}  `]) {
      expect(profiles.renameProxyProfile(base, id, name).proxyProfiles[0].name).to.equal(name.normalize('NFKC').trim());
    }
    for (const name of ['x'.repeat(33), '😀'.repeat(33), 'ﬃ'.repeat(11), '', ' \t ', 'a\u0000b', 'a\u007fb', 'a\nb']) {
      expect(() => profiles.renameProxyProfile(base, id, name)).to.throw().with.property('code', 'PROXY_INVALID_NAME');
    }
    expect(profiles.MAX_PROXY_NAME_LENGTH).to.equal(32);
    expect(profiles.proxyNameLength('  Ａ😀e\u0301ﬃ  ')).to.equal(6);
    expect(profiles.proxyNameLength('')).to.equal(0);
    const renamed = profiles.renameProxyProfile(base, id, '  Ａ😀  ');
    expect(profiles.renameProxyProfile(renamed, id, 'Ａ😀')._proxyCatalogRevision).to.equal(renamed._proxyCatalogRevision);
  });
  it('grandfathers saved long names on hydration and unrelated edits, but not explicit renames', () => {
    const base = setup('HTTPS a.test:443; HTTPS b.test:443');
    const legacy = { ...base, proxyProfiles: base.proxyProfiles.map((p, i) => ({ ...p, name: 'x'.repeat(i ? 80 : 33) })),
      domainProxyIds: { 'site.test': base.proxyProfiles[0].id } };
    const loaded = profiles.reconcileProxyProfiles(legacy);
    expect(loaded).to.equal(legacy);
    const edited = profiles.reconcileProxyProfiles({ ...loaded, ifProxyOrDie: false }, loaded);
    expect(edited.proxyProfiles).to.equal(legacy.proxyProfiles);
    expect(edited.domainProxyIds).to.equal(legacy.domainProxyIds);
    expect(edited._proxyCatalogRevision).to.equal(legacy._proxyCatalogRevision);
    const selected = profiles.selectDefaultProxy(edited, legacy.proxyProfiles[1].id);
    expect(selected.proxyProfiles).to.equal(legacy.proxyProfiles);
    const renamed = profiles.renameProxyProfile(loaded, legacy.proxyProfiles[1].id, 'New name');
    expect(renamed.proxyProfiles[0]).to.deep.equal(legacy.proxyProfiles[0]);
    expect(renamed.domainProxyIds).to.equal(legacy.domainProxyIds);
    expect(renamed.defaultProxyId).to.equal(legacy.defaultProxyId);
    expect(renamed._proxyCatalogRevision).to.equal(legacy._proxyCatalogRevision + 1);
    for (const profile of loaded.proxyProfiles) {
      expect(() => profiles.renameProxyProfile(loaded, profile.id, profile.name)).to.throw().with.property('code', 'PROXY_INVALID_NAME');
    }
    expect(() => profiles.reconcileProxyProfiles({ ...loaded, proxyProfiles: loaded.proxyProfiles.map((p, i) => i ? p : { ...p, name: 'z'.repeat(33) }) }, loaded))
      .to.throw().with.property('code', 'PROXY_INVALID_NAME');
    const addition = setup('HTTPS c.test:443').proxyProfiles[0];
    expect(() => profiles.reconcileProxyProfiles({ customProxyStringRaw: 'HTTPS c.test:443',
      proxyProfiles: [{ ...addition, name: 'z'.repeat(33) }] }, {}))
      .to.throw().with.property('code', 'PROXY_INVALID_NAME');
    expect(() => profiles.reconcileProxyProfiles({ ...loaded, customProxyStringRaw: `${loaded.customProxyStringRaw}; HTTPS c.test:443`,
      proxyProfiles: [...loaded.proxyProfiles, { ...addition, name: 'z'.repeat(33) }] }, loaded))
      .to.throw().with.property('code', 'PROXY_INVALID_NAME');
  });
  it('generates unique auth-free 32-point names with dynamically sized collision suffixes', () => {
    const host = `${'shared'.repeat(8)}.test`;
    const raw = Array.from({ length: 120 }, (_, i) => `HTTPS user:secret@${host}:${1000 + i}`).join('; ');
    const base = setup(raw);
    const names = base.proxyProfiles.map(p => p.name);
    expect(new Set(names).size).to.equal(120);
    expect(names.every(name => profiles.proxyNameLength(name) === 32)).to.equal(true);
    expect(names[1]).to.match(/ \(2\)$/);
    expect(names[99]).to.match(/ \(100\)$/);
    expect(JSON.stringify(base.proxyProfiles)).not.to.match(/user|secret/);
    const reordered = profiles.reconcileProxyProfiles({ ...base, customProxyStringRaw: raw.split('; ').reverse().join('; ') }, base);
    expect(reordered.proxyProfiles).to.equal(base.proxyProfiles);
    expect(reordered._proxyCatalogRevision).to.equal(base._proxyCatalogRevision);
    const fresh = profiles.reconcileProxyProfiles({ customProxyStringRaw: raw.split('; ').slice(0, 50).join('; ') }, {});
    expect(fresh.proxyProfiles).to.have.length(50);
    expect(new Set(fresh.proxyProfiles.map(p => p.name)).size).to.equal(50);
  });
  it('reserves named profiles before generating names regardless of raw order', () => {
    const stem = 'shared'.repeat(8);
    const oldRaw = `HTTPS ${stem}-old.test:443`;
    const newRaw = `HTTPS ${stem}-new.test:443`;
    const base = setup(oldRaw);
    const existing = base.proxyProfiles[0];
    for (const customProxyStringRaw of [`${newRaw};${oldRaw}`, `${oldRaw};${newRaw}`]) {
      const next = profiles.reconcileProxyProfiles({ ...base, customProxyStringRaw }, base);
      expect(next.proxyProfiles.find(p => p.id === existing.id)).to.deep.equal(existing);
      const added = next.proxyProfiles.find(p => p.id !== existing.id);
      expect(added.name).to.match(/ \(2\)$/);
      expect(profiles.proxyNameLength(added.name)).to.equal(32);
      expect(next.defaultProxyId).to.equal(base.defaultProxyId);
      expect(next.domainProxyIds).to.deep.equal(base.domainProxyIds);
    }
    const explicit = setup(oldRaw).proxyProfiles[0];
    const fresh = profiles.reconcileProxyProfiles({ customProxyStringRaw: `${newRaw};${oldRaw}`, proxyProfiles: [explicit] }, {});
    expect(fresh.proxyProfiles.find(p => p.id === explicit.id)).to.deep.equal(explicit);
    expect(new Set(fresh.proxyProfiles.map(p => p.name)).size).to.equal(2);
  });
  it('rejects uppercase and NFKC-equivalent duplicate names', () => {
    const base = setup('HTTPS a.test:443; HTTPS b.test:443');
    const named = profiles.renameProxyProfile(base, base.proxyProfiles[0].id, 'Primary');
    for (const name of ['PRIMARY', '  Ｐｒｉｍａｒｙ  ']) {
      expect(() => profiles.renameProxyProfile(named, base.proxyProfiles[1].id, name)).to.throw().with.property('code', 'PROXY_DUPLICATE_NAME');
    }
  });
  it('rejects a 51st saved custom endpoint even if secure-only disables it and builtins are enabled', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `HTTP p${i}.test:8080`).join('; ');
    const base = profiles.reconcileProxyProfiles({ customProxyStringRaw: raw,
      ifUseSecureProxiesOnly: true, ifUseLocalTor: true, ifUseLocalWarp: true });
    expect(base.proxyProfiles).to.have.length(50);
    expect(() => profiles.reconcileProxyProfiles({ ...base,
      customProxyStringRaw: `${raw}; HTTP extra.test:8080` }, base))
      .to.throw().with.property('code', 'PROXY_LIMIT');
  });
  it('never compiles credentials or a registry endpoint absent from raw connections', () => {
    expect(profiles.MAX_CUSTOM_PROXIES).to.equal(50);
    const raw = setup('HTTPS user:secret@a.test:443');
    const routes = profiles.compileProxyRoutes(raw);
    expect(routes[raw.proxyProfiles[0].id]).to.equal('HTTPS a.test:443');
    expect(profiles.compileProxyRoutes({ ...raw, customProxyStringRaw: '' })).to.deep.equal({});
    expect(profiles.compileProxyRoutes({ ...raw, proxyProfiles: [{ ...raw.proxyProfiles[0], endpoint: 'HTTPS user:secret@a.test:443' }] })).to.deep.equal({});
  });
  it('keeps oversized legacy catalogs readable and editable without a historical high-water mark', () => {
    const raw = Array.from({ length: 120 }, (_, i) => `HTTPS p${i}.test:443`).join('; ');
    const base = setup(raw);
    expect(base.proxyProfiles).to.have.length(120);
    const renamed = profiles.renameProxyProfile(base, base.proxyProfiles[0].id, 'Legacy');
    const selected = profiles.selectDefaultProxy(renamed, base.proxyProfiles[1].id);
    const reordered = profiles.reconcileProxyProfiles({ ...selected,
      customProxyStringRaw: raw.split('; ').reverse().join('; ') }, selected);
    expect(reordered.proxyProfiles).to.deep.equal(selected.proxyProfiles);
    const edited = profiles.reconcileProxyProfiles({ ...reordered,
      customProxyStringRaw: raw.replace('p119.test', 'replacement.test') }, reordered);
    expect(edited.proxyProfiles).to.have.length(120);
    const reduced = profiles.reconcileProxyProfiles({ ...edited,
      customProxyStringRaw: raw.split('; ').slice(0, 55).join('; ') }, edited);
    expect(reduced.proxyProfiles).to.have.length(55);
    expect(() => profiles.reconcileProxyProfiles({ ...reduced,
      customProxyStringRaw: `${reduced.customProxyStringRaw}; HTTPS extra.test:443` }, reduced))
      .to.throw().with.property('code', 'PROXY_LIMIT');
  });
  it('does not count invalid or duplicate legacy lines as allowance to add unique endpoints', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `HTTPS p${i}.test:443`).join('; ');
    const base = setup(`${raw}; ${Array(60).fill('HTTPS p0.test:443; BROKEN old').join('; ')}`);
    expect(base.proxyProfiles).to.have.length(50);
    expect(() => profiles.reconcileProxyProfiles({ ...base,
      customProxyStringRaw: `${base.customProxyStringRaw}; HTTPS extra.test:443` }, base))
      .to.throw().with.property('code', 'PROXY_LIMIT');
  });
  it('supports empty catalog and sequential empty-snapshot migration', () => {
    expect(profiles.getProxyCatalog({})).to.have.length(2);
    const first = profiles.reconcileProxyProfiles({});
    const second = profiles.reconcileProxyProfiles({ ...first, exceptions: { 'new.test': true } }, first);
    expect(second.defaultProxyId).to.equal(null);
    expect(second.domainProxyIds).to.deep.equal({});
  });
  it('preserves malformed legacy lines on unrelated edits but rejects newly introduced ones', () => {
    const base = setup('HTTPS a.test:443; NOT_A_PROXY legacy; HTTP user:secret@b.test:80');
    const next = profiles.reconcileProxyProfiles({ ...base, customProxyStringRaw: `${base.customProxyStringRaw}; HTTPS c.test:443` }, base);
    expect(next.customProxyStringRaw).to.include('NOT_A_PROXY legacy');
    expect(next.proxyProfiles).to.have.length(3);
    const deleted = profiles.deleteProxyProfile(next, next.proxyProfiles[0].id, next.proxyProfiles[1].id);
    expect(deleted.customProxyStringRaw).to.include('NOT_A_PROXY legacy');
    expect(deleted.customProxyStringRaw).to.include('user:secret@b.test:80');
    expect(() => profiles.reconcileProxyProfiles({ ...base, customProxyStringRaw: `${base.customProxyStringRaw}; BROKEN new` }, base)).to.throw();
  });
  it('preserves IDs over auth and formatting edits and rejects new conflicts without secrets', () => {
    const base = setup('HTTP user:old@localhost:08080');
    const next = profiles.reconcileProxyProfiles({ ...base, customProxyStringRaw: 'PROXY user:new@127.0.0.1:8080' }, base);
    expect(next.proxyProfiles).to.equal(base.proxyProfiles);
    for (const [raw, code] of [
      ['HTTP one:secret@localhost:8080; HTTPS two:hidden@[::1]:8080', 'PROXY_AUTH_CONFLICT'],
      ['SOCKS localhost:1080; SOCKS4 [::1]:01080', 'PROXY_DUPLICATE_ENDPOINT'],
      ['BANANA nope:12', 'PROXY_INVALID_ENDPOINT'],
      ['SOCKS5 one:secret@a.test:1080', 'PROXY_SOCKS_AUTH'],
    ]) {
      try { profiles.reconcileProxyProfiles({ ...base, customProxyStringRaw: raw }, base); expect.fail('accepted'); }
      catch (error) { expect(error.code).to.equal(code); expect(error.message).not.to.match(/secret|hidden/); }
    }
  });
  it('renames and selects defaults as metadata only and protects reserved names', () => {
    const base = setup('HTTPS a.test:443; HTTP b.test:80');
    const [a, b] = base.proxyProfiles;
    const next = profiles.renameProxyProfile(base, a.id, '  Primary  ');
    expect(next.proxyProfiles[0]).to.include({ id: a.id, name: 'Primary' });
    expect(next.domainProxyIds).to.equal(base.domainProxyIds);
    expect(next._proxyCatalogRevision).to.equal(base._proxyCatalogRevision + 1);
    expect(profiles.selectDefaultProxy(next, b.id).defaultProxyId).to.equal(b.id);
    for (const name of ['tor', ' WARP ', 'Cloudflare WARP', b.name, 'x'.repeat(81)]) expect(() => profiles.renameProxyProfile(base, a.id, name)).to.throw();
    expect(() => profiles.renameProxyProfile(base, 'builtin:tor', 'Other')).to.throw();
  });
  it('requires atomic replacement and keeps disabled assignments fail closed', () => {
    const base = setup('HTTP a.test:80; HTTPS b.test:443');
    const [a, b] = base.proxyProfiles;
    const bound = profiles.reconcileProxyProfiles({ ...base, domainProxyIds: { 'site.test': a.id } }, base);
    expect(() => profiles.deleteProxyProfile(bound, a.id)).to.throw();
    const deleted = profiles.deleteProxyProfile(bound, a.id, b.id);
    expect(deleted.domainProxyIds['site.test']).to.equal(b.id);
    expect(deleted.customProxyStringRaw).to.equal('HTTPS b.test:443');
    const secure = profiles.reconcileProxyProfiles({ ...bound, ifUseSecureProxiesOnly: true }, bound);
    expect(profiles.getProxyCatalog(secure).find(p => p.id === a.id).enabled).to.equal(false);
    expect(profiles.resolveProxyRoute(secure, 'site.test')).to.include({ assigned: true, unavailable: true, chain: 'PROXY 127.0.0.1:1' });
    const builtins = profiles.reconcileProxyProfiles({ ...base, ifUseLocalTor: true, ifUseLocalWarp: true, ifUseSecureProxiesOnly: true }, base);
    expect(profiles.compileProxyRoutes(builtins)['builtin:tor']).to.include('SOCKS5');
    expect(profiles.compileProxyRoutes(builtins)['builtin:warp']).not.to.include('SOCKS');
    expect(() => profiles.reconcileProxyProfiles({ ...base, domainProxyIds: { 'site.test': 'builtin:tor' } }, base)).to.throw();
  });
  it('canonicalizes IDN/IPv6 and preserves first-added order', () => {
    const base = setup('HTTPS bücher.test:00443; SOCKS4 [2001:db8:0:0::1]:1080');
    expect(base.proxyProfiles[0].endpoint).to.equal('HTTPS xn--bcher-kva.test:443');
    expect(base.proxyProfiles[1].endpoint).to.equal('SOCKS [2001:db8::1]:1080');
    const next = profiles.reconcileProxyProfiles({ ...base, customProxyStringRaw: 'SOCKS [2001:db8::1]:1080; HTTPS xn--bcher-kva.test:443' }, base);
    expect(next.proxyProfiles).to.equal(base.proxyProfiles);
  });
  it('migrates stable auth-free identities without assigning legacy rules', () => {
    const raw = profiles.reconcileProxyProfiles({ customProxyStringRaw: 'HTTP user:secret@EXAMPLE.test:08080', exceptions: { 'old.test': true } });
    expect(raw.proxyProfiles[0]).to.include({ endpoint: 'PROXY example.test:8080' });
    expect(raw.proxyProfiles[0].id).to.match(/^custom:[\da-f-]{36}$/);
    expect(JSON.stringify(raw.proxyProfiles)).not.to.include('secret');
    expect(raw.domainProxyIds).to.deep.equal({});
    expect(raw.defaultProxyId).to.equal(raw.proxyProfiles[0].id);
    const again = profiles.reconcileProxyProfiles({ ...raw, ifProxyOrDie: false }, raw);
    expect(again.proxyProfiles).to.equal(raw.proxyProfiles);
    expect(again.domainProxyIds).to.equal(raw.domainProxyIds);
    expect(again._proxyCatalogRevision).to.equal(raw._proxyCatalogRevision);
  });
});
