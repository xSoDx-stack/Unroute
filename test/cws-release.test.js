import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import JSZip from 'jszip';
import {
  verifyChromeArchive,
  publishToCws,
} from '../.github/scripts/cws-release.mjs';

async function makeChromeZip(manifest) {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256 };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe('Chrome Web Store API v2 publication', () => {
  it('wires cws-publish into build-release.yml behind CWS_PUBLISH_ENABLED', () => {
    const buildWorkflow = readFileSync(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');
    const cwsWorkflowPath = new URL('../.github/workflows/cws-publish.yml', import.meta.url);
    expect(existsSync(cwsWorkflowPath)).to.equal(true);
    expect(buildWorkflow).to.include("vars.CWS_PUBLISH_ENABLED == 'true'");
    expect(buildWorkflow).to.include('uses: ./.github/workflows/cws-publish.yml');
  });

  it('verifies Chrome MV3 archive manifest version and SHA-256', async () => {
    const { bytes, sha256 } = await makeChromeZip({ manifest_version: 3, version: '3.0.2', name: 'Unroute' });
    const manifest = await verifyChromeArchive(bytes, '3.0.2', sha256);
    expect(manifest.version).to.equal('3.0.2');

    let mismatchError = null;
    try {
      await verifyChromeArchive(bytes, '3.0.3', sha256);
    } catch (err) {
      mismatchError = err;
    }
    expect(mismatchError).to.be.an('error');
    expect(mismatchError.message).to.include('does not match 3.0.3');
  });

  it('skips upload when version is already published or submitted', async () => {
    const { bytes, sha256 } = await makeChromeZip({ manifest_version: 3, version: '3.0.2', name: 'Unroute' });
    const calls = [];
    const fetcher = async (url, options) => {
      calls.push({ url, method: options?.method });
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'tok-1' });
      }
      if (url.endsWith(':fetchStatus')) {
        return jsonResponse({
          publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '3.0.1' }] },
          submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '3.0.2' }] },
        });
      }
      throw new Error(`Unexpected call: ${url}`);
    };

    const result = await publishToCws({
      version: '3.0.2',
      publisherId: 'pub-1',
      extensionId: 'ext-1',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rtok',
      zipBytes: bytes,
      expectedSha256: sha256,
      fetcher,
    });

    expect(result.action).to.equal('skipped');
    expect(result.reason).to.equal('already-submitted');
    expect(calls.map(c => c.method)).to.deep.equal(['POST', 'GET']);
  });

  it('uploads, polls async upload state, and submits for review via API v2', async () => {
    const { bytes, sha256 } = await makeChromeZip({ manifest_version: 3, version: '3.0.2', name: 'Unroute' });
    let statusChecks = 0;
    const endpoints = [];
    const fetcher = async (url, options) => {
      endpoints.push(`${options?.method} ${url}`);
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'tok-2' });
      }
      if (url.endsWith(':fetchStatus')) {
        statusChecks += 1;
        if (statusChecks === 1) {
          return jsonResponse({
            publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '3.0.1' }] },
          });
        }
        return jsonResponse({ lastAsyncUploadState: 'SUCCEEDED' });
      }
      if (url.endsWith(':upload')) {
        expect(url).to.include('https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/ext-1:upload');
        return jsonResponse({ uploadState: 'IN_PROGRESS', crxVersion: '3.0.2' });
      }
      if (url.endsWith(':publish')) {
        expect(JSON.parse(options.body)).to.deep.equal({ publishType: 'DEFAULT_PUBLISH' });
        return jsonResponse({ state: 'PENDING_REVIEW' });
      }
      throw new Error(`Unexpected call: ${url}`);
    };

    const result = await publishToCws({
      version: '3.0.2',
      publisherId: 'pub-1',
      extensionId: 'ext-1',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rtok',
      zipBytes: bytes,
      expectedSha256: sha256,
      fetcher,
      sleep: async () => {},
      pollIntervalMs: 1,
    });

    expect(result.action).to.equal('submitted');
    expect(result.publishType).to.equal('DEFAULT_PUBLISH');
    expect(result.publishState).to.equal('PENDING_REVIEW');
    expect(endpoints).to.have.lengthOf(5);
  });

  it('retries :publish when CWS draft indexing lags with HTTP 400 right after :upload', async () => {
    const { bytes, sha256 } = await makeChromeZip({ manifest_version: 3, version: '3.0.2', name: 'Unroute' });
    let publishCalls = 0;
    const delays = [];
    const fetcher = async url => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({ access_token: 'tok-3' });
      }
      if (url.endsWith(':fetchStatus')) {
        return jsonResponse({
          publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '3.0.1' }] },
        });
      }
      if (url.endsWith(':upload')) {
        return jsonResponse({ uploadState: 'SUCCEEDED', crxVersion: '3.0.2' });
      }
      if (url.endsWith(':publish')) {
        publishCalls += 1;
        if (publishCalls < 3) {
          return jsonResponse({
            error: { message: 'Your submission does not meet the requirements to be published in the store.' },
          }, 400);
        }
        return jsonResponse({ state: 'PENDING_REVIEW' });
      }
      throw new Error(`Unexpected call: ${url}`);
    };

    const result = await publishToCws({
      version: '3.0.2',
      publisherId: 'pub-1',
      extensionId: 'ext-1',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rtok',
      zipBytes: bytes,
      expectedSha256: sha256,
      fetcher,
      sleep: async ms => { delays.push(ms); },
      publishRetryDelayMs: 5000,
    });

    expect(publishCalls).to.equal(3);
    expect(delays).to.deep.equal([5000, 10000]);
    expect(result.action).to.equal('submitted');
    expect(result.publishState).to.equal('PENDING_REVIEW');
  });

  it('does not retry :publish on non-retryable HTTP 403 permission error', async () => {
    const { bytes, sha256 } = await makeChromeZip({ manifest_version: 3, version: '3.0.2', name: 'Unroute' });
    let publishCalls = 0;
    const fetcher = async url => {
      if (url.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'tok-4' });
      if (url.endsWith(':fetchStatus')) return jsonResponse({});
      if (url.endsWith(':upload')) return jsonResponse({ uploadState: 'SUCCEEDED', crxVersion: '3.0.2' });
      if (url.endsWith(':publish')) {
        publishCalls += 1;
        return jsonResponse({ error: { message: 'Forbidden' } }, 403);
      }
      throw new Error(`Unexpected call: ${url}`);
    };

    let caught = null;
    try {
      await publishToCws({
        version: '3.0.2',
        publisherId: 'pub-1',
        extensionId: 'ext-1',
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'rtok',
        zipBytes: bytes,
        expectedSha256: sha256,
        fetcher,
        sleep: async () => {},
      });
    } catch (err) {
      caught = err;
    }

    expect(publishCalls).to.equal(1);
    expect(caught).to.be.an('error');
    expect(caught.message).to.include('Uploaded v3.0.2 to Chrome Web Store draft');
  });
});
