'use strict';

import { t } from './i18n.js';
import { MAX_CUSTOM_PROXIES } from './proxy-profiles.js';

// Stable transport codes are localized at the RPC boundary, never by parsing
// server messages or embedding proxy credentials in user-visible errors.
export function formatRoutingError(code) {
  switch (code) {
    case 'PROXY_SOCKS_AUTH':
      return t('msg_browser_proxy_apis_do_not_support_socks4_sock_4ce96b9a', 'Прокси-API браузера не поддерживает логин и пароль для SOCKS4/SOCKS5 — ни в Chromium, ни в Firefox. Используйте SOCKS без авторизации либо HTTP/HTTPS-прокси.');
    case 'PROXY_DUPLICATE_ENDPOINT':
      return t('msg_this_proxy_is_already_in_the_list_84e5bfa6', 'Такой прокси уже добавлен в список');
    case 'PROXY_INVALID_ENDPOINT':
      return t('msg_check_the_proxy_address_and_port_1_65535_12481406', 'Проверьте адрес прокси и номер порта (1–65535)');
    case 'PROXY_LIMIT':
      return t('msg_too_many_custom_proxies_maximum_sub_350f6c81', 'Слишком много пользовательских прокси. Максимум: $1.', [MAX_CUSTOM_PROXIES]);
    case 'PROXY_INVALID_NAME':
    case 'PROXY_DUPLICATE_NAME':
      return t('mpErrorName', 'Введите уникальное название из 1–32 символов. Имена Tor и Cloudflare WARP зарезервированы.');
    case 'PROXY_AUTH_CONFLICT':
      return t('mpErrorAuth', 'У прокси с одинаковым адресом и портом не могут быть разные данные авторизации.');
    case 'PROXY_BUILTIN_READONLY':
      return t('mpErrorBuiltin', 'Встроенные прокси нельзя переименовывать или удалять.');
    case 'PROXY_INVALID_ID':
    case 'PROXY_INVALID_ASSIGNMENTS':
    case 'PROXY_UNKNOWN_ID':
      return t('mpErrorReference', 'Прокси не найден или его привязка некорректна. Обновите данные и переназначьте сайты.');
    case 'PROXY_UNAVAILABLE':
    case 'PROXY_TARGET_UNAVAILABLE':
      return t('mpErrorUnavailable', 'Выберите включённый прокси, разрешённый текущими ограничениями.');
    case 'PROXY_REPLACEMENT_REQUIRED':
      return t('mpErrorReplacement', 'Перед удалением выберите прокси для переноса привязанных сайтов и настройки по умолчанию.');
    case 'RULES_REVISION_REQUIRED':
    case 'RULES_CONFLICT':
      return t('mpErrorConflict', 'Список изменён или устарел. Обновите данные и повторите действие; черновик сохранён.');
    case 'PROXY_SELECTION_REQUIRED':
      return t('mpErrorChoice', 'Выберите прокси для новых сайтов.');
    case 'INVALID_DOMAIN_LIST':
      return t('dlErrorInvalid', 'Некорректные данные листа. Проверьте название, домены и порядок листов.');
    case 'DOMAIN_LIST_UNKNOWN':
      return t('dlErrorUnknown', 'Лист больше не существует. Обновите данные и повторите действие.');
    case 'INVALID_DOMAIN_MUTATION':
      return t('mpErrorRules', 'Некорректный список изменений сайтов. Проверьте домены и режимы.');
    case 'PROXY_RULE_MISSING':
      return t('mpErrorMissingRule', 'Один из сайтов больше не находится в списке проксируемых. Обновите список.');
    default: return '';
  }
}
