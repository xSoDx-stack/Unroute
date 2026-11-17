import { expect } from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { t, uiLocale, localizeDocument } from '../src/common/core/i18n.js';

const root = fileURLToPath(new URL('../src/common/', import.meta.url));
const catalogs = Object.fromEntries(['ru', 'en'].map(locale => [locale,
  JSON.parse(fs.readFileSync(path.join(root, '_locales', locale, 'messages.json'), 'utf8'))]));

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['vendor', '_locales'].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

describe('Native extension localization contract', () => {
  let original;
  beforeEach(() => { original = globalThis.chrome; });
  afterEach(() => { globalThis.chrome = original; });

  it('provides matching Russian and English keys and substitution contracts', () => {
    expect(Object.keys(catalogs.en).sort()).to.deep.equal(Object.keys(catalogs.ru).sort());
    for (const [key, entry] of Object.entries(catalogs.ru)) {
      expect(catalogs.en[key].message, key).to.be.a('string').and.not.equal('');
      expect(catalogs.en[key].placeholders || {}, key).to.deep.equal(entry.placeholders || {});
    }
    for (const file of ['manifest.json', '../firefox/manifest.json']) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      expect(manifest.default_locale).to.equal('ru');
      expect(manifest.action.default_title).to.equal('__MSG_extName__');
    }
  });

  it('keeps catalogs aligned with messages used by manifests, HTML and JavaScript', () => {
    const used = [];
    const sourceFiles = [...files(root), ...files(path.resolve(root, '../firefox'))];
    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, 'utf8');
      if (file.endsWith('.html')) {
        for (const match of source.matchAll(/data-i18n(?:-(?:title|placeholder|aria-label))?="([^"]+)"/g)) used.push(match[1]);
      } else if (file.endsWith('.json')) {
        for (const match of source.matchAll(/__MSG_(\w+)__/g)) used.push(match[1]);
      } else if (file.endsWith('.js')) {
        const visit = node => {
          if (!node || typeof node !== 'object') return;
          if (node.type === 'CallExpression' && node.callee.name === 't') {
            if (!file.endsWith(`${path.sep}i18n.js`)) expect(node.arguments[0].type, file).to.equal('Literal');
            if (node.arguments[0].type === 'Literal') used.push(node.arguments[0].value);
          }
          if (node.type === 'CallExpression' && node.callee.property?.name === 'getMessage' &&
              node.arguments[0]?.type === 'Literal' && !node.arguments[0].value.startsWith('@@')) {
            used.push(node.arguments[0].value);
          }
          for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
          }
        };
        visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
      }
    }
    for (const key of used) for (const locale of ['ru', 'en']) expect(catalogs[locale], key).to.have.property(key);
    const activeKeys = new Set(used);
    for (const key of Object.keys(catalogs.ru)) expect(activeKeys.has(key), `Unused message: ${key}`).to.equal(true);
    expect(used.length).to.be.greaterThan(600);
  });

  it('passes substitution values to the native API as strings without parsing HTML', () => {
    let received;
    globalThis.chrome = { i18n: { getMessage: (key, values) => {
      received = { key, values }; return 'Native message';
    } } };
    expect(t('key', 'Fallback $1', [5, '<img src=x onerror=alert(1)>'])).to.equal('Native message');
    expect(received).to.deep.equal({ key: 'key', values: ['5', '<img src=x onerror=alert(1)>'] });
    globalThis.chrome = {};
    expect(t('missing', '$1 / $2', ['$2', 7])).to.equal('$2 / 7');
  });

  it('keeps regional date formatting while using the catalog language for unsupported locales', () => {
    globalThis.chrome = { i18n: { getMessage: () => 'en', getUILanguage: () => 'en-GB' } };
    expect(uiLocale()).to.equal('en-GB');
    globalThis.chrome.i18n.getMessage = () => 'ru';
    globalThis.chrome.i18n.getUILanguage = () => 'fr';
    expect(uiLocale()).to.equal('ru');
  });

  it('localizes text and accessible attributes without replacing nested counters or interpreting markup', () => {
    globalThis.chrome = { i18n: { getUILanguage: () => 'en',
      getMessage: key => ({ uiLanguage: 'en', '@@bidi_dir': 'ltr', label: '<img src=x>', hint: 'Safe title' })[key] || '' } };
    const label = { dataset: { i18n: 'label' }, textContent: 'Label' };
    const attributes = { title: 'Title', 'data-i18n-title': 'hint' };
    const button = { getAttribute: key => attributes[key], setAttribute: (key, value) => { attributes[key] = value; } };
    const document = { documentElement: {}, querySelectorAll: selector =>
      selector === '[data-i18n]' ? [label] : selector === '[data-i18n-title]' ? [button] : [] };
    localizeDocument(document);
    expect(label.textContent).to.equal('<img src=x>');
    expect(attributes.title).to.equal('Safe title');
    expect(document.documentElement).to.deep.equal({ lang: 'en', dir: 'ltr' });
  });
});
