import { expect } from 'chai';
import * as editor from '../src/common/pages/options/domain-lists-editor.js';
import * as lists from '../src/common/core/domain-lists.js';

 describe('Domain list text filenames', () => {
  it('imports the last txt extension as a basename and disambiguates existing names', () => {
    expect(editor.domainListImportName).to.be.a('function');
    expect(editor.domainListImportName('Мои сайты.TXT', [])).to.equal('Мои сайты');
    expect(editor.domainListImportName('Work.list.txt', ['work.list'])).to.equal('Work.list (2)');
    expect(editor.domainListImportName('.txt', [])).to.have.length.greaterThan(0);
    expect([...editor.domainListImportName('😀'.repeat(70) + '.txt', [])]).to.have.length(64);
  });
  it('suggests unique names while preserving Unicode and the 64-character limit', () => {
    expect(lists.suggestDomainListName).to.be.a('function');
    expect(lists.suggestDomainListName('Мои сайты', [])).to.equal('Мои сайты');
    expect(lists.suggestDomainListName(' Work ', ['Ｗｏｒｋ', 'work (2)'])).to.equal('Work (3)');
    const base = '😀'.repeat(64);
    const result = lists.suggestDomainListName(base + 'overflow', [base]);
    expect([...result]).to.have.length(64);
    expect(result.endsWith(' (2)')).to.equal(true);
    expect([...lists.suggestDomainListName('İ'.repeat(64), ['İ'.repeat(64).toLowerCase()])]).to.have.length(64);
    expect(lists.suggestDomainListName('Straße', ['STRAẞE'])).to.equal('Straße (2)');
    expect(lists.suggestDomainListName('Straße', ['STRASSE'])).to.equal('Straße');
  });
  it('exports the full list name as a portable txt filename', () => {
    expect(editor.domainListExportFilename).to.be.a('function');
    for (const [name, filename] of [
      ['Мои сайты', 'Мои сайты.txt'], ['Work.list', 'Work.list.txt'], ['Work.txt', 'Work.txt.txt'],
      ['Work: A/B', 'Work_ A_B.txt'], ['CON', '_CON.txt'], ['nul.backup', '_nul.backup.txt'],
      ['Report. ', 'Report.txt'], ['...', 'domains.txt'],
    ]) expect(editor.domainListExportFilename(name)).to.equal(filename);
  });
 });
