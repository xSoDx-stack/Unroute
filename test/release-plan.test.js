import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { resolveReleasePlan } from '../.github/scripts/release-plan.mjs';

describe('Release eligibility', () => {
  it('matches the CI Chrome smoke locale to the Linux runner browser', () => {
    const workflow = readFileSync(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');
    const step = workflow.split('- name:').find(value =>
      /^\s+run:\s+npm run test:browser:chrome\s*$/m.test(value));
    expect(step, 'Chrome smoke step').to.be.a('string');
    expect(step).to.match(/^\s+UNROUTE_TEST_LOCALE:\s+en\s*$/m);
  });

  it('matches the CI Firefox smoke locale to the isolated en-US distribution', () => {
    const workflow = readFileSync(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');
    const step = workflow.split(/\r?\n\s+- name:/).find(value =>
      /^\s+run:\s+npm run test:browser:firefox\s*$/m.test(value));
    expect(step, 'Firefox smoke step').to.be.a('string');
    expect(step).to.match(/^\s+UNROUTE_TEST_LOCALE:\s+en\s*$/m);
  });

  const input = { version: '2.2.30', ref: 'refs/heads/development', event: 'push', repository: 'owner/repo', token: 'test' };
  it('publishes only a previously unpublished version', async () => {
    expect((await resolveReleasePlan({ ...input, fetcher: async () => ({ status: 200 }) })).publish).to.equal(false);
    expect((await resolveReleasePlan({ ...input, fetcher: async () => ({ status: 404 }) })).publish).to.equal(true);
  });
  it('never publishes PRs or unrelated branches and rejects mismatched tags', async () => {
    const fetcher = async () => { throw new Error('Must not call GitHub'); };
    expect((await resolveReleasePlan({ ...input, event: 'pull_request', fetcher })).publish).to.equal(false);
    expect((await resolveReleasePlan({ ...input, ref: 'refs/heads/feature', fetcher })).publish).to.equal(false);
    try { await resolveReleasePlan({ ...input, ref: 'refs/tags/v1.0.0', fetcher }); throw new Error('Expected mismatch'); }
    catch (error) { expect(error.message).to.include('Tag does not match'); }
  });
  it('fails on API outages instead of interpreting them as missing releases', async () => {
    try { await resolveReleasePlan({ ...input, fetcher: async () => ({ status: 503 }) }); throw new Error('Expected HTTP failure'); }
    catch (error) { expect(error.message).to.include('HTTP 503'); }
  });
});
