import { expect } from 'chai';
import fs from 'node:fs';

describe('Appearance localization', () => {
  it('has non-empty matching Russian and English catalogs for every appearance UI key', () => {
    const source = fs.readFileSync(new URL('../src/common/pages/shared/appearance-controls.js', import.meta.url), 'utf8');
    const keys = [...new Set([...source.matchAll(/t\('(appearance_\w+)'/g)].map(match => match[1]))];
    for (const locale of ['en', 'ru']) {
      const messages = JSON.parse(fs.readFileSync(new URL(`../src/common/_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
      for (const key of keys) expect(messages[key]?.message, `${locale} ${key}`).a('string').not.empty;
    }
  });
});
