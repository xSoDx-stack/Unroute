import { expect } from 'chai';
import fs from 'node:fs';
import { formatRoutingError } from '../src/common/core/routing-errors.js';
import { normalizeDomainLists, deleteDomainList } from '../src/common/core/domain-lists.js';
import { applyDomainRuleMutations } from '../src/common/core/domain-rule-mutations.js';

const catalogs = Object.fromEntries(['ru', 'en'].map(locale => [locale,
  JSON.parse(fs.readFileSync(new URL(`../src/common/_locales/${locale}/messages.json`, import.meta.url), 'utf8'))]));

function useLocale(locale) {
  globalThis.chrome = { i18n: { getMessage: key => catalogs[locale][key]?.message || '' } };
}

function thrownCode(action) {
  try { action(); } catch (error) { return error.code; }
  throw new Error('Expected a coded routing error');
}

describe('Review localization regressions', () => {
  let originalChrome;
  beforeEach(() => { originalChrome = globalThis.chrome; });
  afterEach(() => { globalThis.chrome = originalChrome; });

  it('localizes actual invalid and missing domain-list errors at the routing boundary', () => {
    const invalidCode = thrownCode(() => normalizeDomainLists(null));
    const missingCode = thrownCode(() => deleteDomainList({ _rulesRevision: 0 }, { expectedRevision: 0, listId: 'gone' }));
    for (const locale of ['ru', 'en']) {
      useLocale(locale);
      expect(formatRoutingError(invalidCode)).to.equal(catalogs[locale].dlErrorInvalid?.message).and.be.a('string').and.not.equal('');
      expect(formatRoutingError(missingCode)).to.equal(catalogs[locale].dlErrorUnknown?.message).and.be.a('string').and.not.equal('');
    }
    globalThis.chrome = {};
    expect(formatRoutingError(invalidCode)).to.equal('Некорректные данные листа. Проверьте название, домены и порядок листов.');
    expect(formatRoutingError(missingCode)).to.equal('Лист больше не существует. Обновите данные и повторите действие.');
    expect(formatRoutingError('UNKNOWN_INTERNAL_CODE')).to.equal('');
  });

  it('uses the actual English tab name in both proxy warnings', () => {
    for (const key of ['msg_one_or_more_of_your_proxy_servers_are_unavail_6a46dee9',
      'msg_no_working_proxy_configure_a_proxy_in_my_prox_5507b02d']) {
      expect(catalogs.en[key].message).to.include('"Proxies"').and.not.include('My proxy');
    }
  });

  it('localizes fallback policy, stale resource revisions and unavailable inheritance', () => {
    for (const locale of ['ru', 'en']) {
      useLocale(locale);
      for (const [code, key] of Object.entries({
        PROXY_INVALID_FAILOVER: 'mpErrorFailover',
        REVISION_CONFLICT: 'mpErrorResourceRevision',
        RESOURCE_INHERITANCE_UNAVAILABLE: 'mpErrorResourceInheritance',
      })) expect(formatRoutingError(code), code).to.equal(catalogs[locale][key]?.message).and.not.equal('');
    }
  });

  it('keeps count-sensitive Russian messages grammatical without changing substitution contracts', () => {
    const expected = {
      msg_warning_sub_of_your_sub_proxies_are_unavailab_17a33ccc: 'Внимание: недоступных прокси: $param_1$ из $param_2$.',
      msg_repeated_sub_times_0ea8e23d: ' (число повторений: $param_1$)',
      msg_repeated_sub_times_1b3c0c12: 'Число повторений: $param_1$',
      msg_exported_sub_domains_to_sub_5cb228f3: '✓ Экспортировано доменов: $param_1$. Файл: $param_2$.',
    };
    for (const [key, message] of Object.entries(expected)) {
      expect(catalogs.ru[key].message).to.equal(message);
      expect(catalogs.ru[key].placeholders).to.deep.equal(catalogs.en[key].placeholders);
      for (const count of [1, 2, 4, 5, 11, 21, 22, 25]) {
        const rendered = message.replaceAll('$param_1$', String(count)).replaceAll('$param_2$', 'example.txt');
        expect(rendered).to.include(String(count)).and.not.include('$param_');
      }
    }
  });

  it('uses the exact reviewed Russian typography for update, status and report text', () => {
    const expected = {
      msg_updated_loading_44703b2a: 'Обновлён: загрузка…',
      msg_updated_sub_0c40c480: 'Обновлён: $param_1$',
      msg_not_updated_yet_5b05f298: 'Ещё не обновлялся',
      msg_proxy_disabled_a2fd1e2b: 'Прокси отключён',
      msg_unroute_error_report_1566112b: ' Отчёт об ошибках и сбоях расширения «Unroute»\n',
    };
    for (const [key, message] of Object.entries(expected)) {
      expect(catalogs.ru[key].message, key).to.equal(message);
      expect(catalogs.ru[key].placeholders || {}, key).to.deep.equal(catalogs.en[key].placeholders || {});
    }
  });

  it('preserves accepted list terminology, expressive labels and stable history identifiers', () => {
    expect(catalogs.ru.dlAdd.message).to.equal('Добавить лист');
    expect(catalogs.ru.msg_pac_rules_203bc29a.message).to.equal('по PAC');
    expect(catalogs.ru.msg_proxy_or_fail_07ac9e3a.message).to.equal('Проксируй или умри!');
    expect(catalogs.ru.msg_the_last_12_changes_undo_retains_later_manual_dc13d9c9.message).to.include('5 изменений');
    expect(catalogs.en.msg_the_last_12_changes_undo_retains_later_manual_dc13d9c9.message).to.include('5 changes');
  });

  it('already localizes coded domain-rule errors instead of exposing internal Russian diagnostics', () => {
    const code = thrownCode(() => applyDomainRuleMutations({}, null));
    useLocale('en');
    expect(formatRoutingError(code)).to.equal(catalogs.en.mpErrorRules.message);
  });
});
