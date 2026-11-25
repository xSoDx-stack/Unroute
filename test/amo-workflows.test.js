import { expect } from 'chai';
import { readFileSync, existsSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');

describe('Asynchronous AMO listed release workflows', () => {
  it('does not reserve public version numbers through unlisted signing', () => {
    expect(workflow).not.to.include('--channel unlisted');
  });

  it('publishes only user-facing Chrome ZIP on release creation without waiting for Mozilla signing', () => {
    const release = workflow.split('  release:')[1].split('  amo-publish:')[0];
    expect(release).to.be.a('string');
    expect(release).to.match(/needs:\s+verify/);
    expect(release).not.to.include('needs: [verify, sign-firefox]');
    expect(release).to.include('chrome-mv3.zip');
    const createCmd = release.split('gh release create')[1];
    expect(createCmd).to.include('"$chrome_archive"');
    expect(createCmd).not.to.include('.sha256');
    expect(createCmd).not.to.include('amo-request.json');
    expect(createCmd).not.to.include('$firefox_archive');
    expect(createCmd).not.to.include('$source_archive');
  });

  it('protects the initial listed activation with an explicit repository variable', () => {
    expect(workflow).to.include("vars.AMO_LISTED_ENABLED == 'true'");
  });

  it('includes an independent scheduled reconciliation workflow', () => {
    expect(existsSync(new URL('../.github/workflows/amo-publish.yml', import.meta.url))).to.equal(true);
  });
});
