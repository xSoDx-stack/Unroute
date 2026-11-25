import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const GH_API = 'https://api.github.com';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CWS_API_BASE = 'https://chromewebstore.googleapis.com/v2';
const CWS_UPLOAD_BASE = 'https://chromewebstore.googleapis.com/upload/v2';
const MAX_BYTES = 64 * 1024 * 1024;
const ALLOWED_PUBLISH_TYPES = new Set(['DEFAULT_PUBLISH', 'STAGED_PUBLISH']);

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

export function validVersion(version) {
  assert.match(version || '', /^\d+\.\d+\.\d+$/, 'Expected a literal x.y.z version');
}

export function extractStatusVersions(status = {}) {
  const collect = revision => (revision?.distributionChannels || [])
    .map(ch => ch?.crxVersion)
    .filter(v => typeof v === 'string' && v.length > 0);
  return {
    published: collect(status.publishedItemRevisionStatus),
    submitted: collect(status.submittedItemRevisionStatus),
    publishedState: status.publishedItemRevisionStatus?.state || '',
    submittedState: status.submittedItemRevisionStatus?.state || '',
    lastAsyncUploadState: status.lastAsyncUploadState || '',
  };
}

export async function verifyChromeArchive(bytes, expectedVersion, expectedSha256) {
  validVersion(expectedVersion);
  assert.ok(bytes.length > 0 && bytes.length <= MAX_BYTES, 'Archive exceeds the 64 MiB automation limit');
  if (expectedSha256) {
    assert.match(expectedSha256, /^[a-f0-9]{64}$/i, 'Invalid expected SHA-256 digest');
    const actualSha = sha256Hex(bytes);
    assert.equal(actualSha, expectedSha256.toLowerCase(), 'Chrome archive SHA-256 mismatch');
  }
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const manifestEntry = zip.file('manifest.json');
  assert.ok(manifestEntry, 'Archive does not contain manifest.json');
  const manifest = JSON.parse(await manifestEntry.async('string'));
  assert.equal(manifest.manifest_version, 3, 'Expected Manifest V3 extension');
  assert.equal(manifest.version, expectedVersion, `Archive manifest version ${manifest.version} does not match ${expectedVersion}`);
  return manifest;
}

async function fetchJson(url, options, fetcher = fetch) {
  const response = await fetcher(url, {
    ...options,
    signal: options?.signal || AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error_description || data?.error || text.slice(0, 500);
    const err = new Error(`HTTP ${response.status} from ${url}: ${detail}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

export async function exchangeRefreshToken({ clientId, clientSecret, refreshToken }, fetcher = fetch) {
  assert.ok(clientId && clientSecret && refreshToken, 'CWS_CLIENT_ID, CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN must be configured');
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const data = await fetchJson(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, fetcher);
  assert.ok(typeof data?.access_token === 'string' && data.access_token.length > 0, 'OAuth token response missing access_token');
  return data.access_token;
}

async function downloadReleaseAsset({ repository, token, version }, fetcher = fetch) {
  assert.ok(repository && token, 'GITHUB_REPOSITORY and GH_TOKEN must be configured');
  const tag = `v${version}`;
  const release = await fetchJson(`${GH_API}/repos/${repository}/releases/tags/${tag}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
    },
  }, fetcher);

  const zipName = `unroute-v${version}-chrome-mv3.zip`;
  const shaName = `${zipName}.sha256`;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const zipAsset = assets.find(a => a.name === zipName);
  const shaAsset = assets.find(a => a.name === shaName);
  assert.ok(zipAsset?.url, `GitHub Release ${tag} does not contain ${zipName}`);
  assert.ok(shaAsset?.url, `GitHub Release ${tag} does not contain ${shaName}`);

  const downloadBinary = async assetUrl => {
    const res = await fetcher(assetUrl, {
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Failed to download release asset (${res.status}): ${assetUrl}`);
    return Buffer.from(await res.arrayBuffer());
  };

  const [zipBytes, shaBytes] = await Promise.all([
    downloadBinary(zipAsset.url),
    downloadBinary(shaAsset.url),
  ]);
  const shaLine = shaBytes.toString('utf8').trim();
  const match = shaLine.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
  assert.ok(match, `Malformed checksum file ${shaName}`);
  assert.equal(match[2].trim(), zipName, `Checksum file ${shaName} references unexpected file ${match[2]}`);
  return { zipBytes, expectedSha256: match[1].toLowerCase() };
}

export async function publishToCws({
  version,
  publisherId,
  extensionId,
  clientId,
  clientSecret,
  refreshToken,
  publishType = 'DEFAULT_PUBLISH',
  dryRun = false,
  zipBytes,
  expectedSha256,
  fetcher = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  pollIntervalMs = 5000,
  maxPollAttempts = 24,
  publishMaxAttempts = 6,
  publishRetryDelayMs = 5000,
}) {
  validVersion(version);
  assert.ok(publisherId && extensionId, 'CWS_PUBLISHER_ID and CWS_EXTENSION_ID must be configured');
  assert.ok(ALLOWED_PUBLISH_TYPES.has(publishType), `Unsupported publishType: ${publishType}`);

  await verifyChromeArchive(zipBytes, version, expectedSha256);

  const accessToken = await exchangeRefreshToken({ clientId, clientSecret, refreshToken }, fetcher);
  const authHeader = { Authorization: `Bearer ${accessToken}` };
  const itemPath = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`;

  const fetchStatus = () => fetchJson(`${CWS_API_BASE}/${itemPath}:fetchStatus`, {
    method: 'GET',
    headers: authHeader,
  }, fetcher);

  const initialStatus = await fetchStatus();
  const statusInfo = extractStatusVersions(initialStatus);

  if (statusInfo.published.includes(version)) {
    return { action: 'skipped', reason: 'already-published', version, status: statusInfo };
  }
  if (statusInfo.submitted.includes(version)) {
    return { action: 'skipped', reason: 'already-submitted', version, status: statusInfo };
  }
  if (statusInfo.submittedState === 'PENDING_REVIEW') {
    throw new Error(
      `Chrome Web Store already has another revision pending review (${statusInfo.submitted.join(', ') || 'unknown'}). ` +
      'Wait for review completion or cancel it in the Developer Dashboard before submitting a new version.'
    );
  }

  if (dryRun) {
    return { action: 'dry-run', version, status: statusInfo };
  }

  const uploadRes = await fetchJson(`${CWS_UPLOAD_BASE}/${itemPath}:upload`, {
    method: 'POST',
    headers: {
      ...authHeader,
      'Content-Type': 'application/zip',
    },
    body: zipBytes,
    signal: AbortSignal.timeout(120000),
  }, fetcher);

  let uploadState = uploadRes?.uploadState || '';
  if (uploadState === 'IN_PROGRESS' || uploadState === 'UPLOAD_IN_PROGRESS') {
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      await sleep(pollIntervalMs);
      const polled = await fetchStatus();
      uploadState = polled?.lastAsyncUploadState || '';
      if (uploadState === 'SUCCEEDED') break;
      if (uploadState && uploadState !== 'IN_PROGRESS' && uploadState !== 'UPLOAD_IN_PROGRESS') {
        throw new Error(`Chrome Web Store async upload failed with state: ${uploadState}`);
      }
    }
  }

  if (uploadState !== 'SUCCEEDED') {
    throw new Error(`Chrome Web Store upload did not succeed (state: ${uploadState || 'unknown'})`);
  }

  const retryablePublishStatuses = new Set([400, 409, 429, 500, 502, 503, 504]);
  let publishRes = null;
  let lastPublishError = null;
  for (let attempt = 1; attempt <= publishMaxAttempts; attempt += 1) {
    try {
      publishRes = await fetchJson(`${CWS_API_BASE}/${itemPath}:publish`, {
        method: 'POST',
        headers: {
          ...authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ publishType }),
      }, fetcher);
      lastPublishError = null;
      break;
    } catch (err) {
      lastPublishError = err;
      if (!retryablePublishStatuses.has(err?.status) || attempt >= publishMaxAttempts) {
        break;
      }
      await sleep(publishRetryDelayMs * attempt);
      const current = extractStatusVersions(await fetchStatus());
      if (current.published.includes(version) || current.submitted.includes(version)) {
        return {
          action: 'submitted',
          version,
          publishType,
          uploadState,
          publishState: current.submittedState || current.publishedState || 'SUBMITTED',
        };
      }
    }
  }

  if (lastPublishError) {
    throw new Error(
      `Uploaded v${version} to Chrome Web Store draft, but publish failed after ${publishMaxAttempts} attempt(s): ${lastPublishError.message}`
    );
  }

  return {
    action: 'submitted',
    version,
    publishType,
    uploadState,
    publishState: publishRes?.state || 'SUBMITTED',
  };
}

async function main() {
  const version = (process.env.CWS_VERSION || '').trim();
  validVersion(version);

  const { zipBytes, expectedSha256 } = await downloadReleaseAsset({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
    version,
  });

  const result = await publishToCws({
    version,
    publisherId: (process.env.CWS_PUBLISHER_ID || '').trim(),
    extensionId: (process.env.CWS_EXTENSION_ID || '').trim(),
    clientId: (process.env.CWS_CLIENT_ID || '').trim(),
    clientSecret: (process.env.CWS_CLIENT_SECRET || '').trim(),
    refreshToken: (process.env.CWS_REFRESH_TOKEN || '').trim(),
    publishType: (process.env.CWS_PUBLISH_TYPE || 'DEFAULT_PUBLISH').trim(),
    dryRun: process.env.CWS_DRY_RUN === 'true',
    zipBytes,
    expectedSha256,
  });

  console.log(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
