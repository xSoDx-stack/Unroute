import { expect } from 'chai';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PublicationApi, reconcileRelease, prepareRelease, submitPackage, embedRequestMeta, extractRequestMeta, buildVerifiedArtifacts } from '../.github/scripts/amo-release.mjs';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Local HTTP integration fixtures only. Signature bytes below are deliberately
// not a real Mozilla signature; this tests transport and publication decisions.
const guid = 'unroute@xsodx-stack.github.io';
const version = '3.0.1';
const hash = b => createHash('sha256').update(b).digest('hex');
let server, base, state;
const json = (response, code, value) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
// Fetch Standard blocked ports above 1023; lower ports are not assigned by listen(0).
const fetchBlockedEphemeralPorts = new Set([1433, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

async function setUp() {
  const archive = new JSZip();
  archive.file('manifest.json', JSON.stringify({ version, manifest_version: 3, browser_specific_settings: { gecko: { id: guid } } }));
  archive.file('background.js', '// integration fixture');
  const unsigned = await archive.generateAsync({ type: 'nodebuffer' });
  archive.file('META-INF/mozilla.rsa', 'not-a-real-signature');
  const signed = await archive.generateAsync({ type: 'nodebuffer' });
  const sources = new JSZip(); sources.file('LICENSE', 'fixture license');
  const source = await sources.generateAsync({ type: 'nodebuffer' });
  const request = { schema: 1, addonId: guid, version, channel: 'listed', commit: 'a'.repeat(40), files: {
    firefox: { name: 'unroute-v3.0.1-firefox-mv3.zip', sha256: hash(unsigned) },
    source: { name: 'unroute-v3.0.1-sources.zip', sha256: hash(source) },
  } };
  const entries = [[request.files.firefox.name, unsigned], [request.files.source.name, source],
    ['unroute-v3.0.1-amo-request.json', Buffer.from(JSON.stringify(request))]];
  state = { signed, unsigned, source, request, bytes: new Map(), requests: [], uploads: 0,
    addon: { status: 'public', is_disabled: false },
    version: { id: 44, version, channel: 'listed', source: 'fixture-source', file: { status: 'unreviewed' } },
    release: { id: 1, tag_name: 'v3.0.1', draft: false, prerelease: false, body: 'User release notes',
      assets: entries.map(([name], i) => ({ id: i + 1, name, state: 'uploaded' })) } };
  entries.forEach(([, bytes], i) => state.bytes.set(i + 1, bytes));
  server = http.createServer(async (req, res) => {
    const chunks = []; for await (const b of req) chunks.push(b);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://fixture');
    state.requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization });
    if (url.pathname === '/repos/test/repo/releases/1') {
      if (req.method === 'PATCH') state.release.body = JSON.parse(body).body;
      return json(res, 200, state.release);
    }
    if (url.pathname === '/repos/test/repo/git/ref/tags/v3.0.1') return json(res, 200, { object: { type: 'commit', sha: state.request.commit } });
    const asset = url.pathname.match(/^\/repos\/test\/repo\/releases\/assets\/(\d+)$/);
    if (asset) { res.writeHead(200); return res.end(state.bytes.get(Number(asset[1]))); }
    if (url.pathname === '/repos/test/repo/releases/1/assets') {
      state.uploads++;
      const id = state.release.assets.length + 1;
      const item = { id, name: url.searchParams.get('name'), state: 'uploaded' };
      state.release.assets.push(item); state.bytes.set(id, body);
      return json(res, 201, item);
    }
    if (url.pathname === `/api/v5/addons/addon/${encodeURIComponent(guid)}/`) return json(res, 200, state.addon);
    if (url.pathname.endsWith('/versions/v3.0.1/')) return json(res, state.version ? 200 : 404, state.version || { detail: 'fixture not found' });
    if (url.pathname.endsWith('/versions/44/') && req.method === 'PATCH') {
      state.version.source = 'restored-source-fixture';
      return json(res, 200, state.version);
    }
    if (url.pathname === '/firefox/downloads/file/44/fixture.xpi') { res.writeHead(200); return res.end(state.signed); }
    json(res, 404, { detail: 'unknown fixture route' });
  });
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const { port } = server.address();
    if (!fetchBlockedEphemeralPorts.has(port)) {
      base = `http://127.0.0.1:${port}`;
      return;
    }
    await tearDown();
  }
  throw new Error('Could not bind a fixture port permitted by Fetch');
}

async function tearDown() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

function client() {
  return new PublicationApi({ repository: 'test/repo', token: 'fixture-gh-token', issuer: 'fixture-issuer', secret: 'fixture-secret',
    fetcher: (url, options) => { const parsed = new URL(url); return fetch(base + parsed.pathname + parsed.search, options); } });
}

describe('AMO publication local HTTP integration', () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it('repairs a missing source upload only on explicit retry, without creating a version', async () => {
    state.version.source = null;
    expect((await reconcileRelease(client(), structuredClone(state.release))).state).to.equal('attention');
    expect(state.requests.filter(r => r.method === 'PATCH' && r.path.startsWith('/api/'))).to.have.length(0);
    expect((await reconcileRelease(client(), structuredClone(state.release), { allowSubmit: true })).state).to.equal('pending');
    expect(state.requests.filter(r => r.method === 'PATCH' && r.path.startsWith('/api/'))).to.have.length(1);
    expect(state.requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/'))).to.have.length(0);
  });

  it('never forwards GitHub credentials through a download redirect', async () => {
    const seen = [];
    const api = new PublicationApi({ repository: 'test/repo', token: 'fixture-token', fetcher: async (url, options) => {
      seen.push({ url, headers: options.headers });
      return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/fixture' } })
        : new Response('fixture bytes');
    } });
    await api.download('https://api.github.com/repos/test/repo/releases/assets/1', 'github', true);
    expect(seen[0].headers.Authorization).to.equal('Bearer fixture-token');
    expect(seen[1].headers.Authorization).to.equal(undefined);
  });

  it('invokes web-ext listed with zero approval wait, reviewer sources and no GitHub credentials', async () => {
    let called = false;
    await submitPackage(state.addon, state.unsigned, state.source, process.env.TMPDIR || os.tmpdir(), {
      environment: { WEB_EXT_API_KEY: 'fixture-key', WEB_EXT_API_SECRET: 'fixture-secret', GH_TOKEN: 'must-not-pass' },
      execute: async (_program, args, options) => {
        called = true;
        expect(args[args.indexOf('--channel') + 1]).to.equal('listed');
        expect(args[args.indexOf('--approval-timeout') + 1]).to.equal('0');
        expect(options.env.GH_TOKEN).to.equal(undefined);
        expect(options.env.WEB_EXT_API_KEY).to.equal('fixture-key');
        const source = await readFile(args[args.indexOf('--upload-source-code') + 1]);
        expect(source.equals(state.source)).to.equal(true);
        const metadata = JSON.parse(await readFile(args[args.indexOf('--amo-metadata') + 1], 'utf8'));
        expect(metadata.version.custom_license.text['en-US']).to.include('fixture license');
      },
    });
    expect(called).to.equal(true);
  });

  it('polls pending versions without uploading a package and preserves user release notes', async () => {
    const result = await reconcileRelease(client(), structuredClone(state.release));
    expect(result.state).to.equal('pending');
    expect(state.uploads).to.equal(0);
    expect(state.release.body).to.include('User release notes');
    expect(state.requests.filter(r => r.path.startsWith('/api/') && r.method !== 'GET')).to.have.length(0);
  });

  it('downloads approved files without JWT, verifies them, attaches only signed XPI once, and reads it back', async () => {
    state.version.file = { status: 'public', hash: 'sha256:' + hash(state.signed), url: 'https://addons.mozilla.org/firefox/downloads/file/44/fixture.xpi' };
    const api = client();
    const result = await reconcileRelease(api, structuredClone(state.release));
    expect(result.state).to.equal('approved');
    expect(state.uploads).to.equal(1);
    const download = state.requests.find(r => r.path.startsWith('/firefox/downloads/'));
    expect(download.authorization).to.equal(undefined);
    expect(state.release.assets.map(a => a.name)).to.include('unroute-v3.0.1-firefox-mv3.xpi');
    expect(state.release.assets.map(a => a.name)).to.not.include('unroute-v3.0.1-firefox-mv3.xpi.sha256');
    expect(state.release.body).to.include('User release notes');
    await reconcileRelease(api, structuredClone(state.release));
    expect(state.uploads).to.equal(1);
    expect(state.requests.some(r => r.path.startsWith('/api/') && r.authorization?.startsWith('JWT '))).to.equal(true);
  });

  it('reconciles a clean release with zero service assets using embedded metadata and commit build', async () => {
    state.release.assets = [{ id: 99, name: 'unroute-v3.0.1-chrome-mv3.zip', state: 'uploaded' }];
    state.release.body = embedRequestMeta('Clean user release notes', state.request);
    state.version.file = { status: 'public', hash: 'sha256:' + hash(state.signed), url: 'https://addons.mozilla.org/firefox/downloads/file/44/fixture.xpi' };
    let buildCalls = 0;
    const buildArtifacts = async req => {
      buildCalls += 1;
      expect(req.commit).to.equal(state.request.commit);
      return { unsigned: state.unsigned, source: state.source };
    };
    const api = client();
    const result = await reconcileRelease(api, structuredClone(state.release), { buildArtifacts });
    expect(result.state).to.equal('approved');
    expect(buildCalls).to.equal(1);
    expect(state.release.assets.map(a => a.name)).to.deep.equal([
      'unroute-v3.0.1-chrome-mv3.zip',
      'unroute-v3.0.1-firefox-mv3.xpi',
    ]);
    // Subsequent hourly poll skips rebuilding once verified signed XPI is already attached
    await reconcileRelease(api, structuredClone(state.release), { buildArtifacts });
    expect(buildCalls).to.equal(1);
  });

  it('does not fetch or attach disabled versions', async () => {
    state.version.file = { status: 'disabled' };
    const result = await reconcileRelease(client(), structuredClone(state.release));
    expect(result.state).to.equal('attention');
    expect(state.uploads).to.equal(0);
  });

  it('submits only with explicit permission and recovers the exact accepted version', async () => {
    const accepted = state.version; state.version = null;
    let submits = 0;
    const submit = async (_addon, unsigned, source) => {
      expect(unsigned.equals(state.unsigned)).to.equal(true); expect(source.equals(state.source)).to.equal(true);
      submits++; state.version = accepted;
    };
    await reconcileRelease(client(), structuredClone(state.release), { allowSubmit: true, submit });
    await reconcileRelease(client(), structuredClone(state.release), { allowSubmit: true, submit });
    expect(submits).to.equal(1);
  });

  it('ignores old releases without a publication request, including existing 3.0.0', async () => {
    const release = { ...state.release, tag_name: 'v3.0.0', assets: [] };
    expect((await reconcileRelease(client(), release, { allowSubmit: true })).state).to.equal('skipped');
    expect(state.requests).to.have.length(0);
  });

  it('rejects unexpected download hosts before sending any credentials', async () => {
    let error;
    try { await client().download('https://attacker.invalid/stolen', 'amo'); } catch (e) { error = e; }
    expect(error?.message).to.include('Untrusted download URL');
    expect(state.requests).to.have.length(0);
  });

  it('refuses a different existing signed asset instead of clobbering it', async () => {
    state.version.file = { status: 'public', hash: 'sha256:' + hash(state.signed), url: 'https://addons.mozilla.org/firefox/downloads/file/44/fixture.xpi' };
    const id = 10; state.release.assets.push({ id, name: 'unroute-v3.0.1-firefox-mv3.xpi', state: 'uploaded' });
    state.bytes.set(id, Buffer.from('different fixture'));
    let error;
    try { await reconcileRelease(client(), structuredClone(state.release)); } catch (e) { error = e; }
    expect(error?.message).to.include('Refusing to overwrite');
    expect(state.uploads).to.equal(0);
  });

  it('prepares embedded metadata and initial release status locally without auxiliary asset files', async () => {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'amo-prepare-test-'));
    try {
      for (const [name, bytes] of [['chrome-mv3', state.unsigned], ['firefox-mv3', state.unsigned], ['sources', state.source]]) {
        await writeFile(path.join(dir, `unroute-v3.0.1-${name}.zip`), bytes);
      }
      await prepareRelease(dir, { version, commit: state.request.commit, notes: 'Original notes' });
      const notes = await readFile(path.join(dir, 'release-notes.md'), 'utf8');
      expect(notes).to.include('Original notes');
      const request = extractRequestMeta(notes);
      expect(request.files.firefox.sha256).to.equal(hash(state.unsigned));
      expect(request.files.chrome.sha256).to.equal(hash(state.unsigned));
      expect(request.files.source.sha256).to.equal(hash(state.source));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('deterministically builds bit-identical Firefox and source ZIPs from a verified git commit', async function () {
    this.timeout(60000);
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    const headCommit = stdout.trim();
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    const first = await buildVerifiedArtifacts({
      repository: 'test/repo',
      commit: headCommit,
      version: pkg.version,
      repoUrl: repoRoot,
    });
    const second = await buildVerifiedArtifacts({
      repository: 'test/repo',
      commit: headCommit,
      version: pkg.version,
      repoUrl: repoRoot,
    });
    expect(hash(first.unsigned)).to.equal(hash(second.unsigned));
    expect(hash(first.source)).to.equal(hash(second.source));
  });
});
