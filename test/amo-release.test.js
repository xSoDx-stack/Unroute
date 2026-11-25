import { expect } from 'chai';
import { createHmac, createHash } from 'node:crypto';
import JSZip from 'jszip';

// Explicit test fixtures: no calls to AMO/GitHub or real credentials.
const fixture = { version: '3.0.1', addonId: 'unroute@xsodx-stack.github.io', channel: 'listed',
  schema: 1, commit: 'a'.repeat(40), files: {
    firefox: { name: 'unroute-v3.0.1-firefox-mv3.zip', sha256: 'b'.repeat(64) },
    source: { name: 'unroute-v3.0.1-sources.zip', sha256: 'c'.repeat(64) },
  } };
let api;
before(async () => { api = await import('../.github/scripts/amo-release.mjs'); });

const addon = { status: 'public', is_disabled: false, default_locale: 'ru',
  name: { ru: 'User title' }, summary: { ru: 'User summary' }, categories: { firefox: ['other'] } };
const version = { id: 123, version: '3.0.1', channel: 'listed', source: 'source-url',
  file: { status: 'unreviewed' } };
const digest = data => createHash('sha256').update(data).digest('hex');

async function archives() {
  const unsigned = new JSZip();
  unsigned.file('manifest.json', JSON.stringify({ manifest_version: 3, version: '3.0.1',
    browser_specific_settings: { gecko: { id: fixture.addonId } } }) + '\n');
  unsigned.file('background.js', '/* verified build */');
  const bytes = await unsigned.generateAsync({ type: 'nodebuffer' });
  const signed = await JSZip.loadAsync(bytes);
  signed.file('manifest.json', (await signed.file('manifest.json').async('string')).trim());
  signed.file('META-INF/cose.sig', 'fixture signature marker, not a real Mozilla signature');
  return { bytes, signed };
}

describe('AMO listed automation', () => {
  it('creates short-lived HS256 JWTs without credentials in the payload', () => {
    const token = api.amoJwt('test-issuer', 'test-secret', 1000);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url'))).to.deep.equal({ alg: 'HS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    expect(claims.iss).to.equal('test-issuer');
    expect(claims.iat).to.equal(1000);
    expect(claims.exp - claims.iat).to.be.at.most(300);
    expect(claims).not.to.have.property('secret');
    expect(signature).to.equal(createHmac('sha256', 'test-secret').update(`${header}.${payload}`).digest('base64url'));
  });

  it('validates immutable request identity, filenames and hashes', () => {
    expect(api.validateRequest(fixture, '3.0.1')).to.equal(fixture);
    for (const change of [{ channel: 'unlisted' }, { version: '3.0.0' }, { addonId: 'other-id' }, { commit: '../x' }]) {
      expect(() => api.validateRequest({ ...fixture, ...change }, '3.0.1')).to.throw();
    }
    expect(() => api.validateRequest({ ...fixture, files: { ...fixture.files,
      source: { name: '../secret', sha256: 'c'.repeat(64) } } }, '3.0.1')).to.throw();
  });

  it('distinguishes waiting, approval and attention without mislabelling disabled as a definite rejection', () => {
    expect(api.amoState(addon, version)).to.equal('pending');
    expect(api.amoState(addon, { ...version, file: { status: 'public', url: 'https://addons.mozilla.org/file.xpi', hash: 'sha256:' + 'a'.repeat(64) } })).to.equal('approved');
    expect(api.amoState(addon, { ...version, file: { status: 'disabled' } })).to.equal('attention');
    expect(api.amoState({ ...addon, status: 'rejected' }, version)).to.equal('attention');
    expect(api.amoState({ ...addon, is_disabled: true }, version)).to.equal('attention');
    expect(api.amoState(addon, { ...version, channel: 'unlisted' })).to.equal('conflict');
    expect(api.amoState(addon, { ...version, file: { status: 'unexpected' } })).to.equal('attention');
    expect(api.amoState(addon, { ...version, source: null })).to.equal('attention');
  });

  it('preserves existing listing metadata and explicitly retains GPL-3.0-or-later on the first listed version', () => {
    const metadata = api.makeMetadata(addon, 'full GPL license fixture');
    expect(metadata).not.to.have.property('name');
    expect(metadata).not.to.have.property('summary');
    expect(metadata).not.to.have.property('categories');
    expect(metadata.version.custom_license.name['en-US']).to.include('or later');
    expect(metadata.version.custom_license.text['en-US']).to.equal('full GPL license fixture');
    const initial = api.makeMetadata({ default_locale: 'ru' }, 'license');
    expect(initial.name.ru).to.equal('Unroute');
    expect(initial.summary.ru).to.be.a('string');
    expect(initial.categories.firefox).to.deep.equal(['privacy-security']);
  });

  it('accepts AMO manifest whitespace changes but rejects any changed executable code, missing signature or wrong hash', async () => {
    const { bytes, signed } = await archives();
    const good = await signed.generateAsync({ type: 'nodebuffer' });
    await api.checkSignedXpi(good, bytes, fixture, 'sha256:' + digest(good));
    signed.file('background.js', '/* unexpected code */');
    const modified = await signed.generateAsync({ type: 'nodebuffer' });
    let error;
    try { await api.checkSignedXpi(modified, bytes, fixture, 'sha256:' + digest(modified)); } catch (e) { error = e; }
    expect(error?.message).to.include('background.js');
    try { await api.checkSignedXpi(good, bytes, fixture, 'sha256:' + '0'.repeat(64)); } catch (e) { error = e; }
    expect(error?.message).to.include('hash');
    try { await api.checkSignedXpi(bytes, bytes, fixture, 'sha256:' + digest(bytes)); } catch (e) { error = e; }
    expect(error?.message).to.include('signature');
  });

  it('updates only its own release-status section', () => {
    const original = 'User release notes\n\nOther details';
    const updated = api.statusBody(original, 'pending', '3.0.1');
    expect(updated).to.include(original);
    const approved = api.statusBody(updated, 'approved', '3.0.1');
    expect(approved).to.include(original);
    expect(approved.match(/<!-- unroute-amo:start -->/g)).to.have.length(1);
    expect(approved).not.to.include('ожидает');
  });

  it('never submits from the scheduled read-only poll when a version is absent', async () => {
    let submits = 0;
    const result = await api.processVersion({ request: fixture, addon, existing: null, allowSubmit: false,
      submit: async () => { submits++; }, lookup: async () => null });
    expect(result.state).to.equal('not-submitted');
    expect(submits).to.equal(0);
  });

  it('does not resubmit an existing pending, approved, disabled or unlisted version', async () => {
    let submits = 0;
    for (const existing of [version, { ...version, file: { status: 'disabled' } }, { ...version, channel: 'unlisted' }]) {
      await api.processVersion({ request: fixture, addon, existing, allowSubmit: true,
        submit: async () => { submits++; }, lookup: async () => null });
    }
    expect(submits).to.equal(0);
  });

  it('recovers an accepted submission after a client timeout without a second submission', async () => {
    let submits = 0;
    const result = await api.processVersion({ request: fixture, addon, existing: null, allowSubmit: true,
      submit: async () => { submits++; throw Error('fixture client timeout'); }, lookup: async () => version });
    expect(result.state).to.equal('pending');
    expect(submits).to.equal(1);
  });

  it('reports a genuinely failed submission and does not silently turn it into pending', async () => {
    const result = await api.processVersion({ request: fixture, addon, existing: null, allowSubmit: true,
      submit: async () => { throw Error('fixture validation failure'); }, lookup: async () => null });
    expect(result.state).to.equal('submission-failed');
  });
});
