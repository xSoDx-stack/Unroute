import { expect } from 'chai';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');

describe('Documentation-only CI exclusions', () => {
  for (const [event, next] of [['push', 'pull_request'], ['pull_request', 'workflow_dispatch']]) {
    it(`ignores only README and documentation paths for ${event}`, () => {
      const block = workflow.slice(workflow.indexOf(`  ${event}:`), workflow.indexOf(`  ${next}:`));
      expect(block).to.include('paths-ignore:');
      for (const ignored of ["- 'README.md'", "- 'docs/**'", "- '.github/AMO.md'"]) {
        expect(block).to.include(ignored);
      }
      expect(block).not.to.include("- '**/*.md'");
      expect(block).not.to.include("- '.github/**'");
    });
  }

  it('retains release-tag and manual triggers', () => {
    expect(workflow).to.include("      - 'v*'");
    expect(workflow).to.include('  workflow_dispatch:');
  });
});
