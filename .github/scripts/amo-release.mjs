import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, appendFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ADDON = 'unroute@xsodx-stack.github.io';
const AMO = 'https://addons.mozilla.org/api/v5/addons/';
const GH = 'https://api.github.com';
const MAX_BYTES = 64 * 1024 * 1024;
const startMarker = '<!-- unroute-amo:start -->';
const endMarker = '<!-- unroute-amo:end -->';
const metaPrefix = '<!-- unroute-amo-meta:';
const metaSuffix = '-->';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);

export function amoJwt(issuer, secret, now = Math.floor(Date.now() / 1000)) {
  assert.ok(issuer && secret, 'AMO_JWT_ISSUER and AMO_JWT_SECRET must be configured');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 180 })}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function validVersion(version) {
  assert.match(version || '', /^\d+\.\d+\.\d+$/, 'Expected a literal x.y.z version');
  const parts = version.split('.').map(Number);
  assert.ok(parts.every(Number.isSafeInteger), 'Invalid version');
  assert.ok(parts[0] > 3 || (parts[0] === 3 && (parts[1] > 0 || parts[2] > 0)),
    'Version 3.0.0 and earlier must not be submitted: 3.0.0 already occupies the unlisted channel');
}

export function validateRequest(request, version) {
  validVersion(version);
  assert.equal(request.schema, 1);
  assert.equal(request.version, version);
  assert.equal(request.addonId, ADDON);
  assert.equal(request.channel, 'listed');
  assert.match(request.commit, /^[a-f0-9]{40}$/);
  for (const [key, suffix] of [['firefox', 'firefox-mv3.zip'], ['source', 'sources.zip']]) {
    assert.equal(request.files?.[key]?.name, `unroute-v${version}-${suffix}`);
    assert.match(request.files[key].sha256, /^[a-f0-9]{64}$/);
  }
  if (request.files?.chrome !== undefined) {
    assert.equal(request.files.chrome?.name, `unroute-v${version}-chrome-mv3.zip`);
    assert.match(request.files.chrome.sha256, /^[a-f0-9]{64}$/);
  }
  return request;
}

export function embedRequestMeta(body = '', request) {
  const serialized = JSON.stringify(request);
  assert.ok(!serialized.includes('-->'), 'Request metadata cannot contain HTML comment terminator');
  const block = `${metaPrefix}${serialized}${metaSuffix}`;
  const first = body.indexOf(metaPrefix);
  if (first !== -1) {
    const last = body.indexOf(metaSuffix, first + metaPrefix.length);
    assert.ok(last !== -1, 'Malformed AMO metadata comment');
    return body.slice(0, first) + block + body.slice(last + metaSuffix.length);
  }
  const statusIdx = body.indexOf(startMarker);
  if (statusIdx !== -1) {
    return `${body.slice(0, statusIdx).trimEnd()}\n\n${block}\n\n${body.slice(statusIdx)}`;
  }
  return `${body.trimEnd()}\n\n${block}\n`;
}

export function extractRequestMeta(body = '') {
  const text = String(body || '');
  const first = text.indexOf(metaPrefix);
  if (first === -1) return null;
  const last = text.indexOf(metaSuffix, first + metaPrefix.length);
  assert.ok(last !== -1, 'Malformed AMO metadata comment');
  assert.equal(text.indexOf(metaPrefix, last + metaSuffix.length), -1, 'Duplicate AMO metadata comment');
  return JSON.parse(text.slice(first + metaPrefix.length, last).trim());
}

export function amoState(addon, version) {
  if (version.channel !== 'listed') return 'conflict';
  if (!version.source) return 'attention';
  if (addon.is_disabled || ['disabled', 'deleted', 'rejected', 'incomplete'].includes(addon.status)) return 'attention';
  if (version.file?.status === 'disabled') return 'attention';
  if (version.file?.status === 'public' && addon.status === 'public' && version.file.url && version.file.hash) return 'approved';
  if (['unreviewed', 'public'].includes(version.file?.status)) return 'pending';
  return 'attention';
}

export function makeMetadata(addon, license) {
  const locale = addon.default_locale || 'en-US';
  const hasLocale = value => typeof value === 'string' ? value.trim() : value?.[locale]?.trim();
  const metadata = { version: { custom_license: {
    name: { 'en-US': 'GNU General Public License v3.0 or later', [locale]: 'GNU General Public License v3.0 or later' },
    text: { 'en-US': license, [locale]: license },
  } } };
  if (!hasLocale(addon.name)) metadata.name = { ...(typeof addon.name === 'object' ? addon.name : {}), [locale]: 'Unroute' };
  if (!hasLocale(addon.summary)) metadata.summary = { ...(typeof addon.summary === 'object' ? addon.summary : {}), [locale]: locale.startsWith('ru')
    ? 'Выборочная маршрутизация сайтов через PAC и собственные прокси. Профили прокси и пользовательские списки доменов.'
    : 'Selective browser routing through PAC and your own proxies, with named proxy profiles and custom domain lists.' };
  if (!addon.categories?.firefox?.length) metadata.categories = { ...addon.categories, firefox: ['privacy-security'] };
  return metadata;
}

export function statusBody(body = '', state, version) {
  const messages = {
    pending: 'Mozilla проверяет версию. Подписанный XPI будет добавлен после публикации в AMO.',
    approved: 'Версия опубликована в AMO. Подписанный Firefox XPI доступен в файлах релиза.',
    attention: 'Требуется внимание: проверьте состояние версии, карточку и передачу исходников в Mozilla Developer Hub.',
    conflict: 'Номер версии уже занят в другом канале AMO; повторная отправка не выполнялась.',
    'not-submitted': 'Версия ещё не отправлена в AMO. Нужен запуск Publish Firefox on AMO с разрешением отправки.',
    'submission-failed': 'Отправка в AMO не подтверждена. Проверьте настройки/валидацию и повторите разрешённую отправку.',
  };
  assert.ok(messages[state], 'Unknown AMO state');
  const section = `${startMarker}\n**Firefox ${version}:** ${messages[state]}\n${endMarker}`;
  const first = body.indexOf(startMarker), last = body.indexOf(endMarker);
  if (first !== -1 || last !== -1) {
    assert.ok(first !== -1 && last > first, 'Malformed AMO status section');
    assert.equal(body.indexOf(startMarker, first + startMarker.length), -1, 'Duplicate AMO status section');
    return body.slice(0, first) + section + body.slice(last + endMarker.length);
  }
  return `${body.trimEnd()}\n\n${section}\n`;
}

async function zipPayload(bytes) {
  assert.ok(bytes.length > 0 && bytes.length <= MAX_BYTES, 'Archive exceeds the 64 MiB automation limit');
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const result = new Map();
  for (const entry of Object.values(zip.files)) {
    const original = entry.unsafeOriginalName || entry.name;
    assert.ok(!original.startsWith('/') && !original.includes('\\') && !original.split('/').includes('..'), 'Unsafe archive path');
    if (!entry.dir) result.set(entry.name, await entry.async('nodebuffer'));
  }
  return result;
}

function checkManifest(bytes, version) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.browser_specific_settings?.gecko?.id, ADDON);
  assert.ok(!manifest.key && !manifest.update_url);
  return manifest;
}

export async function checkSignedXpi(bytes, unsigned, request, hash) {
  assert.match(hash || '', /^sha256:[a-f0-9]{64}$/i, 'AMO must provide a sha256 hash');
  assert.equal(sha(bytes), hash.slice(7).toLowerCase(), 'AMO signed XPI hash mismatch');
  const [signed, original] = await Promise.all([zipPayload(bytes), zipPayload(unsigned)]);
  assert.ok(signed.has('META-INF/cose.sig') || signed.has('META-INF/mozilla.rsa'), 'Missing Mozilla signature metadata');
  assert.deepEqual(checkManifest(signed.get('manifest.json'), request.version),
    checkManifest(original.get('manifest.json'), request.version), 'Signed manifest differs from the verified build');
  signed.delete('manifest.json'); original.delete('manifest.json');
  for (const name of signed.keys()) if (name.startsWith('META-INF/')) signed.delete(name);
  assert.deepEqual([...signed.keys()].sort(), [...original.keys()].sort(), 'Signed XPI file set differs from the verified build');
  for (const [name, content] of original) assert.ok(content.equals(signed.get(name)), `Signed XPI differs: ${name}`);
}

export async function processVersion({ request, addon, existing, allowSubmit, submit, lookup }) {
  if (!existing && allowSubmit) {
    try { await submit(); } catch {
      // A timeout can happen after AMO has accepted the version. Never submit twice.
      existing = await lookup();
      if (!existing) return { state: 'submission-failed' };
    }
    if (!existing) existing = await lookup();
  }
  if (!existing) return { state: 'not-submitted' };
  assert.equal(existing.version, request.version, 'AMO returned another version');
  return { state: amoState(addon, existing), version: existing };
}

function safeURL(value, provider) {
  const url = new URL(value);
  const hosts = provider === 'amo' ? ['addons.mozilla.org', 'addons.cdn.mozilla.net', 'addons.mozilla.net']
    : ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
  assert.ok(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && hosts.includes(url.hostname),
    'Untrusted download URL');
  return url;
}

async function boundedBytes(response) {
  assert.ok(response.ok, `Download failed: HTTP ${response.status}`);
  assert.ok(Number(response.headers.get('content-length') || 0) <= MAX_BYTES, 'Download is too large');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) { await response.body.cancel?.().catch(() => {}); throw new Error('Download is too large'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class PublicationApi {
  constructor({ repository, token, issuer, secret, fetcher = fetch }) {
    assert.match(repository || '', /^[\w.-]+\/[\w.-]+$/);
    assert.ok(token, 'GH_TOKEN is required');
    this.repository = repository; this.token = token; this.issuer = issuer; this.secret = secret; this.fetcher = fetcher;
  }
  async json(provider, suffix, { method = 'GET', body, missing = false } = {}) {
    const url = provider === 'amo' ? new URL(suffix, AMO) : new URL(suffix, `${GH}/repos/${this.repository}/`);
    const expected = provider === 'amo' ? 'https://addons.mozilla.org' : GH;
    assert.equal(url.origin, expected, 'Authenticated request escaped its API origin');
    const authorization = provider === 'amo' ? `JWT ${amoJwt(this.issuer, this.secret)}` : `Bearer ${this.token}`;
    const response = await this.fetcher(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: authorization, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (missing && response.status === 404) return null;
    assert.ok(response.ok, `${provider.toUpperCase()} API ${method} failed: HTTP ${response.status}`);
    return response.json();
  }
  lookup(version) { return this.json('amo', `addon/${encodeURIComponent(ADDON)}/versions/v${version}/`, { missing: true }); }
  async uploadSource(version, bytes) {
    assert.ok(Number.isSafeInteger(version.id) && version.id > 0, 'Invalid AMO version id');
    const body = new FormData();
    body.set('source', new Blob([bytes], { type: 'application/zip' }), 'sources.zip');
    const url = `${AMO}addon/${encodeURIComponent(ADDON)}/versions/${version.id}/`;
    const response = await this.fetcher(url, { method: 'PATCH', body, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `JWT ${amoJwt(this.issuer, this.secret)}` } });
    assert.ok(response.ok, `AMO source upload failed: HTTP ${response.status}`);
    const verified = await this.lookup(version.version);
    assert.ok(verified?.source, 'AMO source upload read-back failed');
    return verified;
  }
  async download(url, provider, authenticated = false) {
    let current = safeURL(url, provider);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const headers = authenticated && current.origin === GH ? { Authorization: `Bearer ${this.token}`, Accept: 'application/octet-stream' } : {};
      const response = await this.fetcher(current.href, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = safeURL(new URL(response.headers.get('location'), current).href, provider);
        authenticated = false; // Never forward API credentials to storage/CDN redirects.
      } else return boundedBytes(response);
    }
    throw new Error('Too many download redirects');
  }
  asset(release, name) {
    const matches = release.assets.filter(item => item.name === name);
    assert.equal(matches.length, 1, `Expected one release asset: ${name}`);
    assert.equal(matches[0].state, 'uploaded');
    return matches[0];
  }
  assetBytes(asset) {
    assert.ok(Number.isSafeInteger(asset.id), 'Invalid GitHub asset id');
    return this.download(`${GH}/repos/${this.repository}/releases/assets/${asset.id}`, 'github', true);
  }
  async upload(release, name, bytes, contentType) {
    const fresh = await this.json('github', `releases/${release.id}`);
    const existing = fresh.assets.find(item => item.name === name);
    if (existing) {
      assert.ok(bytes.equals(await this.assetBytes(existing)), `Refusing to overwrite different immutable asset: ${name}`);
      return;
    }
    const url = `https://uploads.github.com/repos/${this.repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
    const response = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': contentType }, body: bytes });
    assert.ok(response.ok, `GitHub asset upload failed: HTTP ${response.status}`);
    const uploaded = await response.json();
    assert.equal(uploaded.name, name);
    const verified = await this.json('github', `releases/${release.id}`);
    assert.ok(bytes.equals(await this.assetBytes(this.asset(verified, name))), 'GitHub asset read-back failed');
  }
  async status(release, state, version) {
    const current = await this.json('github', `releases/${release.id}`);
    const body = statusBody(current.body || '', state, version);
    if (body === current.body) return;
    await this.json('github', `releases/${release.id}`, { method: 'PATCH', body: { body } });
    const verified = await this.json('github', `releases/${release.id}`);
    assert.equal(verified.body, body, 'GitHub release-status read-back failed');
  }
}

export async function prepareRelease(directory, { version, commit, notes = '' }) {
  validVersion(version);
  assert.match(commit || '', /^[a-f0-9]{40}$/);
  const request = { schema: 1, version, addonId: ADDON, channel: 'listed', commit, files: {} };
  for (const [key, suffix] of [['chrome', 'chrome-mv3.zip'], ['firefox', 'firefox-mv3.zip'], ['source', 'sources.zip']]) {
    const name = `unroute-v${version}-${suffix}`;
    const bytes = await readFile(path.join(directory, name));
    const hash = sha(bytes);
    const payload = await zipPayload(bytes);
    request.files[key] = { name, sha256: hash };
    if (key === 'firefox') checkManifest(payload.get('manifest.json'), version);
  }
  validateRequest(request, version);
  const withStatus = statusBody(notes, 'not-submitted', version);
  await writeFile(path.join(directory, 'release-notes.md'), embedRequestMeta(withStatus, request));
  return request;
}

export async function buildVerifiedArtifacts({
  repository,
  token = '',
  commit,
  version,
  temporaryRoot = os.tmpdir(),
  repoUrl = '',
}) {
  validVersion(version);
  assert.match(commit || '', /^[a-f0-9]{40}$/, 'Invalid commit SHA');
  if (!repoUrl) assert.match(repository || '', /^[\w.-]+\/[\w.-]+$/, 'Invalid GitHub repository');
  const temp = await mkdtemp(path.join(temporaryRoot, 'unroute-build-'));
  try {
    const workDir = path.join(temp, 'work');
    await mkdir(workDir);
    const allowedEnv = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR',
      'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS']);
    const baseEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => allowedEnv.has(k))),
      GIT_TERMINAL_PROMPT: '0',
    };
    const fetchEnv = (!repoUrl && token)
      ? {
        ...baseEnv,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      }
      : baseEnv;
    const origin = repoUrl || `https://github.com/${repository}.git`;
    await exec('git', ['init', '-q'], { cwd: workDir, env: baseEnv });
    await exec('git', ['config', 'core.autocrlf', 'false'], { cwd: workDir, env: baseEnv });
    await exec('git', ['fetch', '--depth', '1', '--no-tags', origin, commit], { cwd: workDir, timeout: 120000, env: fetchEnv });
    await exec('git', ['checkout', '-q', '--detach', 'FETCH_HEAD'], { cwd: workDir, env: baseEnv });

    const [rootLock, workLock] = await Promise.all([
      readFile(path.join(root, 'package-lock.json'), 'utf8').catch(() => null),
      readFile(path.join(workDir, 'package-lock.json'), 'utf8'),
    ]);
    if (rootLock !== null && rootLock.replace(/\r\n/g, '\n') === workLock.replace(/\r\n/g, '\n')) {
      await symlink(path.join(root, 'node_modules'), path.join(workDir, 'node_modules'), 'junction');
    } else {
      const npmCliJs = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
      const hasNpmCli = await readFile(npmCliJs).then(() => true, () => false);
      if (hasNpmCli) {
        await exec(process.execPath, [npmCliJs, 'ci', '--no-audit', '--no-fund'], { cwd: workDir, timeout: 300000, env: baseEnv });
      } else {
        await exec('npm', ['ci', '--no-audit', '--no-fund'], {
          cwd: workDir, timeout: 300000, env: baseEnv, shell: process.platform === 'win32',
        });
      }
    }
    await exec(process.execPath, [path.join(workDir, 'node_modules/gulp/bin/gulp.js'), 'buildTargets'], {
      cwd: workDir, timeout: 120000, env: baseEnv,
    });
    await exec(process.execPath, [path.join(workDir, 'scripts/package-stores.mjs')], {
      cwd: workDir, timeout: 120000, env: baseEnv,
    });
    const outDir = path.join(workDir, 'artifacts', `v${version}`);
    const [unsigned, source] = await Promise.all([
      readFile(path.join(outDir, `unroute-v${version}-firefox-store.zip`)),
      readFile(path.join(outDir, `unroute-v${version}-sources.zip`)),
    ]);
    return { unsigned, source };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function submitPackage(addon, unsigned, source, temporaryRoot, { execute = exec, environment = process.env } = {}) {
  const temp = await mkdtemp(path.join(temporaryRoot, 'unroute-amo-'));
  try {
    const extension = path.join(temp, 'extension');
    await mkdir(extension);
    for (const [name, bytes] of await zipPayload(unsigned)) {
      const target = path.join(extension, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const sources = await zipPayload(source);
    assert.ok(sources.has('LICENSE'), 'Reviewer source archive has no license');
    const license = 'Unroute is licensed under GNU GPL version 3 or, at your option, any later version.\n\n' + sources.get('LICENSE').toString('utf8');
    const metadataPath = path.join(temp, 'amo-metadata.json');
    const sourcePath = path.join(temp, 'sources.zip');
    await writeFile(metadataPath, JSON.stringify(makeMetadata(addon, license)));
    await writeFile(sourcePath, source);
    // No shell, no credentials in argv. Validation is bounded; approval is asynchronous.
    const allowedEnv = new Set(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR',
      'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET']);
    const childEnv = Object.fromEntries(Object.entries(environment).filter(([key]) => allowedEnv.has(key)));
    await execute(process.execPath, [path.join(root, 'node_modules/web-ext/bin/web-ext.js'), 'sign',
      '--source-dir', extension, '--artifacts-dir', path.join(temp, 'signed'), '--channel', 'listed',
      '--approval-timeout', '0', '--timeout', '300000', '--amo-metadata', metadataPath,
      '--upload-source-code', sourcePath, '--no-input'], { cwd: temp, timeout: 480000, maxBuffer: 2 * 1024 * 1024,
      env: childEnv });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function reconcileRelease(api, release, {
  allowSubmit = false,
  temporaryRoot = os.tmpdir(),
  submit = submitPackage,
  buildArtifacts = req => buildVerifiedArtifacts({
    repository: api.repository,
    token: api.token,
    commit: req.commit,
    version: req.version,
    temporaryRoot,
  }),
} = {}) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) return { state: 'skipped' };
  const version = release.tag_name.slice(1), marker = `unroute-v${version}-amo-request.json`;
  let rawRequest = extractRequestMeta(release.body || '');
  if (!rawRequest && release.assets.some(asset => asset.name === marker)) {
    rawRequest = JSON.parse((await api.assetBytes(api.asset(release, marker))).toString('utf8'));
  }
  if (!rawRequest) return { state: 'skipped' };
  const request = validateRequest(rawRequest, version);
  let ref = (await api.json('github', `git/ref/tags/${release.tag_name}`)).object;
  for (let count = 0; ref.type === 'tag' && count < 5; count++) ref = (await api.json('github', `git/tags/${ref.sha}`)).object;
  assert.equal(ref.type, 'commit');
  assert.equal(ref.sha, request.commit, 'Release tag does not match verified build commit');

  let builtPromise = null;
  const ensureBuilt = () => {
    if (!builtPromise) builtPromise = buildArtifacts(request);
    return builtPromise;
  };
  const getUnsigned = async () => {
    const unsigned = release.assets.some(asset => asset.name === request.files.firefox.name)
      ? await api.assetBytes(api.asset(release, request.files.firefox.name))
      : (await ensureBuilt()).unsigned;
    assert.equal(sha(unsigned), request.files.firefox.sha256, 'Verified Firefox ZIP hash mismatch');
    checkManifest((await zipPayload(unsigned)).get('manifest.json'), version);
    return unsigned;
  };
  const getSource = async () => {
    const source = release.assets.some(asset => asset.name === request.files.source.name)
      ? await api.assetBytes(api.asset(release, request.files.source.name))
      : (await ensureBuilt()).source;
    assert.equal(sha(source), request.files.source.sha256, 'Reviewer source ZIP hash mismatch');
    return source;
  };

  let addon = await api.json('amo', `addon/${encodeURIComponent(ADDON)}/`);
  const existing = await api.lookup(version);
  const result = await processVersion({ request, addon, existing, allowSubmit, lookup: () => api.lookup(version), submit: async () => {
    const [unsigned, source] = await Promise.all([getUnsigned(), getSource()]);
    await submit(addon, unsigned, source, temporaryRoot);
  } });
  if (allowSubmit && result.version?.channel === 'listed' && !result.version.source) {
    // Repair a source-upload failure after an accepted submission, without
    // creating another version. The hourly read-only poll never does this.
    result.version = await api.uploadSource(result.version, await getSource());
  }
  if (result.version) {
    // Submission may have changed addon status from incomplete to nominated/public.
    addon = await api.json('amo', `addon/${encodeURIComponent(ADDON)}/`);
    result.state = amoState(addon, result.version);
  }
  if (result.state === 'approved') {
    const file = result.version.file;
    const name = `unroute-v${version}-firefox-mv3.xpi`;
    const existingXpiAsset = release.assets.find(asset => asset.name === name);
    let alreadyVerified = false;
    if (existingXpiAsset && /^sha256:[a-f0-9]{64}$/i.test(file.hash || '')) {
      const existingBytes = await api.assetBytes(api.asset(release, name));
      if (sha(existingBytes) === file.hash.slice(7).toLowerCase()) {
        alreadyVerified = true;
      }
    }
    if (!alreadyVerified) {
      const [signed, unsigned] = await Promise.all([api.download(file.url, 'amo'), getUnsigned()]);
      await checkSignedXpi(signed, unsigned, request, file.hash);
      await api.upload(release, name, signed, 'application/x-xpinstall');
    }
  }
  await api.status(release, result.state, version);
  return { state: result.state, version };
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'prepare') {
    const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const notes = await readFile(path.join(root, `.github/release-notes/v${version}.md`), 'utf8');
    await prepareRelease(process.argv[3], { version, commit: process.env.GITHUB_SHA, notes });
    return;
  }
  assert.equal(mode, 'reconcile', 'Use prepare <directory> or reconcile');
  const version = process.env.AMO_VERSION || '';
  if (version) validVersion(version);
  assert.ok(process.env.AMO_SUBMIT_NEW !== 'true' || version, 'Select one explicit version before permitting a submission');
  const api = new PublicationApi({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN,
    issuer: process.env.WEB_EXT_API_KEY, secret: process.env.WEB_EXT_API_SECRET });
  assert.ok(process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET, 'Configure both AMO JWT secrets');
  const releases = [];
  if (version) releases.push(await api.json('github', `releases/tags/v${version}`));
  else {
    for (let page = 1; ; page++) {
      assert.ok(page <= 10, 'Release scan limit reached; run manually with a specific version');
      const batch = await api.json('github', `releases?per_page=100&page=${page}`);
      releases.push(...batch);
      if (batch.length < 100) break;
    }
  }
  let failed = false;
  for (const release of releases) {
    try {
      const result = await reconcileRelease(api, release, { allowSubmit: process.env.AMO_SUBMIT_NEW === 'true',
        temporaryRoot: process.env.RUNNER_TEMP || process.env.TMPDIR || os.tmpdir() });
      console.log(`${release.tag_name}: ${result.state}`);
      if (['attention', 'conflict', 'not-submitted', 'submission-failed'].includes(result.state)) failed = true;
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${release.tag_name}: **${result.state}**\n`);
    } catch {
      // Do not expose JWTs, signed download URLs or subprocess output in logs.
      console.error(`AMO release processing failed for ${/^v\d+\.\d+\.\d+$/.test(release.tag_name) ? release.tag_name : '(invalid tag)'}. Check request hashes, API access and Mozilla Developer Hub.`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('AMO automation failed. Check configuration and API access; no credentials are logged.'); process.exitCode = 1; });
}
