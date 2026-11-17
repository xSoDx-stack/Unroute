import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('./browser/native-popup-smoke.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const scratch = ast.body.filter(node => node.type === 'VariableDeclaration')
  .flatMap(node => node.declarations).find(node => node.id.name === 'scratch');

// Exercise the runner's real initializer without starting Firefox or creating files.
const resolveScratch = env => vm.runInNewContext(source.slice(scratch.init.start, scratch.init.end), {
  process: { env }, os: { tmpdir: () => '/runner/temp' },
});

describe('Native popup smoke runner temporary directory', () => {
  it('uses the system temporary directory when TMPDIR is unset', () => {
    expect(resolveScratch({})).to.equal('/runner/temp');
  });

  it('preserves an explicitly configured TMPDIR', () => {
    expect(resolveScratch({ TMPDIR: 'C:/test-scratch' })).to.equal('C:/test-scratch');
  });
});
