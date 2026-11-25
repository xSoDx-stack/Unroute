import { expect } from 'chai';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse } from 'acorn';

const publicDocs = [
  'assets-attribution.md', 'credits.md', 'domain-lists.md', 'popup-guide.md', 'proxy-guide.md',
];

describe('Public documentation policy', () => {
  it('ships only user guides and attribution, without internal reports or process notes', () => {
    const script = readFileSync(new URL('../scripts/package-stores.mjs', import.meta.url), 'utf8');
    const ast = parse(script, { ecmaVersion: 'latest', sourceType: 'module' });
    const sourceLoop = ast.body.find(node => node.type === 'ForOfStatement' &&
      node.right.type === 'ArrayExpression' && node.right.elements.some(value => value.value === 'README.md'));
    expect(sourceLoop, 'explicit source inputs').to.exist;
    const inputs = sourceLoop.right.elements.map(value => value.value);
    expect(inputs).not.to.include('docs');
    expect(inputs.filter(value => value.startsWith('docs/')).map(value => value.slice(5)).sort()).to.deep.equal(publicDocs);
    // Local store copy is ignored by Git and excluded by the packaging allowlist.
    const shippedDocs = readdirSync(new URL('../docs/', import.meta.url))
      .filter(name => name !== 'chrome-store-description.md');
    expect(shippedDocs.sort()).to.deep.equal(publicDocs);
    const ignored = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(ignored).to.include('/docs/chrome-store-description.md');
    for (const name of publicDocs) {
      const url = new URL(`../docs/${name}`, import.meta.url);
      const text = readFileSync(url, 'utf8');
      expect(text, name).not.to.match(/\b(?:Luna|Hermes|Claude|Gemini|Codex|Antigravity|RPC|DOM|backend|codec|readback|reasoning|gpt-\d)\b|ревью|результаты верификации|\b(?:PASS|RED|GREEN)\b/i);
      for (const [, href] of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        if (/^(?:https?:|mailto:|#)/i.test(href)) continue;
        expect(existsSync(new URL(href.split('#')[0], url)), `${name}: ${href}`).to.equal(true);
      }
    }
  });
});
