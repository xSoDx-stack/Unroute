import { t } from '../../core/i18n.js';

// Explicit descriptions only: never derive help from values, endpoints or credentials.
const HELP = [
  ["[data-tab=\"pac\"]", () => t("settings_help_nav_pac", "Выбрать источник правил и обновить PAC.")],
  ["[data-tab=\"exceptions\"]", () => t("settings_help_nav_exceptions", "Настроить маршруты и исключения для сайтов.")],
  ["[data-tab=\"proxies\"]", () => t("settings_help_nav_proxies", "Добавить прокси и выбрать маршрут по умолчанию.")],
  ["[data-tab=\"mods\"]", () => t("settings_help_nav_mods", "Изменить ограничения маршрутизации PAC.")],
  ["[data-tab=\"logs\"]", () => t("settings_help_nav_logs", "Просмотреть ошибки сети, PAC и прокси.")],
  ["[data-tab=\"history\"],#openHistoryBtn", () => t("settings_help_nav_history", "Просмотреть изменения правил и отменить доступные операции.")],
  ["[data-tab=\"tools\"]", () => t("settings_help_nav_tools", "Открыть диагностику, код PAC и сброс настроек.")],
  ["[data-tab=\"notifications\"]", () => t("settings_help_nav_notifications", "Выбрать уведомления об ошибках и потере контроля.")],
  ["[data-tab=\"appearance\"]", () => t("settings_help_nav_appearance", "Настроить тему и акцентный цвет интерфейса.")],
  ["[data-provider=\"Антизапрет\"],[data-provider=\"Антизапрет\"] input", () => t("settings_help_provider_az", "Использовать правила Антизапрета для обхода блокировок.")],
  ["[data-provider=\"Антицензорити\"],[data-provider=\"Антицензорити\"] input", () => t("settings_help_provider_ac", "Использовать расширенную базу правил Антицензорити.")],
  ["[data-provider=\"onlyOwnSites\"],[data-provider=\"onlyOwnSites\"] input", () => t("settings_help_provider_own", "Проксировать только вручную добавленные сайты.")],
  ["[data-provider=\"customPacUrl\"],[data-provider=\"customPacUrl\"] input", () => t("settings_help_provider_custom", "Использовать PAC-скрипт по вашей ссылке.")],
  ["[data-provider=\"none\"],[data-provider=\"none\"] input", () => t("settings_help_provider_none", "Освободить настройки прокси браузера, отключив расширение.")],
  ["#customPacUrlInput", () => t("settings_help_pac_url", "Введите ссылку на готовый PAC-скрипт.")],
  ["#saveCustomPacUrlBtn", () => t("settings_help_pac_apply", "Сохранить ссылку и применить выбранный PAC.")],
  ["#syncBtn", () => t("settings_help_pac_update", "Заново загрузить правила выбранного PAC-провайдера.")],
  ["#clearHistoryBtn", () => t("settings_help_history_clear", "Удалить записи истории без изменения текущих правил.")],
  [".history-row button", () => t("settings_help_history_undo", "Отменить это изменение, сохранив последующие ручные правки.")],
  ["#importFileBtn", () => t("settings_help_import", "Добавить домены из .txt в текущий список.")],
  ["#domainListsBack", () => t("settings_help_dl_back", "Вернуться к листам, сохранив изменения редактора.")],
  ["#manualRulesLink", () => t("settings_help_dl_manual", "Открыть ручные правила, которые имеют приоритет над листами.")],
  ["#domainListAdd", () => t("settings_help_dl_add", "Создать отдельный пустой лист с одним назначенным прокси.")],
  ["#domainListImport", () => t("settings_help_dl_import", "Создать новый независимый лист из файла UTF-8 .txt.")],
  ["#domainListsRetry", () => t("settings_help_site_retry", "Повторить чтение списков после ошибки загрузки.")],
  ["#domainListName", () => t("settings_help_dl_name", "Название листа: от 1 до 64 символов.")],
  ["#domainListProxy,.domain-list-row select", () => t("settings_help_dl_proxy", "Назначить один доступный профиль прокси всему листу.")],
  ["#domainListFile", () => t("settings_help_dl_file", "Загрузить домены из UTF-8 .txt, по одному в строке, до 5 МБ.")],
  ["#domainListSave", () => t("settings_help_dl_save", "Сохранить изменения листа после проверки данных.")],
  ["#domainListCancel,.domain-list-dialog button:first-child", () => t("settings_help_dl_cancel", "Закрыть форму или подтверждение без изменения листа.")],
  [".domain-list-name", () => t("settings_help_dl_open", "Открыть редактор доменов только этого листа.")],
  [".domain-list-handle", () => t("settings_help_dl_drag", "Перетащить лист для смены приоритета. Alt + ↑/↓ — с клавиатуры; Esc — отменить перетаскивание.")],
  [".domain-list-row input[type=checkbox]", () => t("settings_help_dl_enabled", "Включить или исключить лист из маршрутизации, не удаляя домены.")],
  [".domain-list-row .domain-list-actions button:nth-child(1)", () => t("settings_help_dl_up", "Поднять лист: первый включённый совпавший лист имеет приоритет.")],
  [".domain-list-row .domain-list-actions button:nth-child(2)", () => t("settings_help_dl_down", "Опустить лист ниже в порядке приоритета.")],
  [".domain-list-row .domain-list-actions button:nth-child(3)", () => t("settings_help_dl_rename", "Изменить название листа, сохранив его домены и прокси.")],
  [".domain-list-row .btn-danger", () => t("settings_help_dl_delete", "Удалить только этот лист после подтверждения; другие листы и ручные правила сохранятся.")],
  [".domain-list-dialog button:last-child", () => t("settings_help_dl_confirm", "Подтвердить действие, показанное в этом окне.")],
  ["[data-subtab=pac]", () => t("settings_help_dl_pac", "Показать ручные PAC-исключения, которые обходят пользовательские листы.")],
  ["#bulkDelete", () => t("settings_help_dl_bulk_delete", "Удалить отмеченные домены только из этого листа.")],
  ["#exportFileBtn", () => t("settings_help_export", "Скачать домены текущего списка в формате .txt.")],
  ["#modeToggleBtn", () => t("settings_help_site_mode", "Переключить списки сайтов между карточками и текстом.")],
  ["#retrySitesLoad", () => t("settings_help_site_retry", "Повторить чтение списков после ошибки загрузки.")],
  ["#newRuleProxy", () => t("settings_help_site_target", "Выбрать прокси для новых сайтов и импорта.")],
  ["[data-subtab=\"included\"]", () => t("settings_help_list_proxy", "Показать сайты с принудительным маршрутом через прокси.")],
  ["[data-subtab=\"excluded\"]", () => t("settings_help_list_direct", "Показать сайты с прямым соединением без прокси.")],
  ["[data-subtab=\"whitelist\"]", () => t("settings_help_list_white", "Показать домены белого списка.")],
  ["#newDomainInput", () => t("settings_help_site_input", "Введите домен или маску для добавления в текущий список.")],
  ["#addDomainBtn", () => t("settings_help_site_add", "Сохранить введённый домен в текущем списке правил.")],
  ["#searchDomainInput", () => t("settings_help_site_search", "Отфильтровать текущий список по части домена.")],
  ["#proxyFilter", () => t("settings_help_site_proxy_filter", "Показать сайты с выбранным назначением прокси.")],
  ["#sourceFilter", () => t("settings_help_site_source_filter", "Отфильтровать правила по способу их добавления.")],
  ["#clearListBtn", () => t("settings_help_site_clear", "Удалить все правила текущего списка после подтверждения.")],
  ["#selectAllFiltered", () => t("settings_help_site_select_all", "Выбрать или снять выбор всех найденных сайтов, включая ещё не показанные.")],
  ["#bulkProxy", () => t("settings_help_site_bulk_target", "Выбрать новый прокси для отмеченных сайтов.")],
  ["#bulkAssign", () => t("settings_help_site_bulk", "Назначить выбранный прокси всем отмеченным сайтам.")],
  ["#clearSelection", () => t("settings_help_site_deselect", "Снять отметки со всех выбранных сайтов.")],
  [".domain-select", () => t("settings_help_site_select", "Включить сайт в выбор для массового переноса.")],
  [".domain-proxy-select", () => t("settings_help_site_assign", "Изменить прокси, назначенный только этому сайту.")],
  [".delete-domain-btn", () => t("settings_help_site_delete", "Удалить правило сайта из текущего списка.")],
  ["#rawTextEditor", () => t("settings_help_site_raw", "Редактировать три списка; изменения сохраняются автоматически.")],
  ["#rawRetrySave", () => t("settings_help_site_raw_retry", "Обновить ревизию правил и повторить сохранение вашего текста.")],
  ["[data-list-scope] [id$=importFileBtn]", () => t("settings_help_dl_replace", "Заменить домены только этого листа из .txt после просмотра и подтверждения.")],
  ["[data-list-scope] textarea", () => t("settings_help_dl_raw", "Редактировать домены только этого листа; изменения сохраняются автоматически.")],
  ["[data-list-scope] .domain-select", () => t("settings_help_dl_select", "Отметить домен для удаления из этого листа.")],
  ["#proxyEditorModeToggle", () => t("settings_help_proxy_mode", "Переключить редактор прокси между формой и текстом.")],
  ["#defaultProxySelect", () => t("settings_help_proxy_default", "Назначить прокси по умолчанию для новых сайтов.")],
  ["#proxyName,.proxy-profile-editor input", () => t("settings_help_proxy_name", "Название прокси: до 32 символов, без изменения адреса. В закрытых селекторах popup показано до 6 символов; полное имя — в списке и подсказке.")],
  ["#proxyProtocol", () => t("settings_help_proxy_protocol", "Выбрать протокол соединения с прокси-сервером.")],
  ["#proxyHost", () => t("settings_help_proxy_host", "Введите имя хоста или IP-адрес прокси-сервера.")],
  ["#proxyPort", () => t("settings_help_proxy_port", "Введите порт, на котором прокси принимает соединения.")],
  ["#proxyAuthCheck", () => t("settings_help_proxy_auth", "Включить ввод логина и пароля для HTTP/HTTPS-прокси.")],
  ["#proxyUser", () => t("settings_help_proxy_user", "Введите имя пользователя для авторизации на прокси.")],
  ["#proxyPass", () => t("settings_help_proxy_pass", "Введите пароль для авторизации на прокси.")],
  ["#addProxyBtn", () => t("settings_help_proxy_add", "Проверить доступность и сохранить новый прокси.")],
  ["#recheckAllProxiesBtn", () => t("settings_help_proxy_check_all", "Повторно проверить доступность настроенных прокси.")],
  [".recheck-btn", () => t("settings_help_proxy_check", "Повторно проверить доступность этого прокси.")],
  [".rename-proxy-btn", () => t("settings_help_proxy_rename", "Открыть редактор названия этого прокси.")],
  [".proxy-actions .delete-btn", () => t("settings_help_proxy_delete", "Выбрать замену и подготовить удаление этого прокси.")],
  [".proxy-profile-editor select", () => t("settings_help_proxy_replace", "Выбрать прокси, на который будут перенесены зависимые сайты.")],
  [".proxy-profile-editor button:first-of-type", () => t("settings_help_proxy_submit", "Применить переименование или удаление с выбранной заменой.")],
  [".proxy-profile-editor button:last-of-type", () => t("settings_help_proxy_cancel", "Закрыть редактор без сохранения изменений прокси.")],
  ["#customProxyText", () => t("settings_help_proxy_raw", "Редактировать список прокси; сохранение — кнопкой «Применить».")],
  ["#saveProxiesBtn", () => t("settings_help_proxy_save", "Сохранить изменения текстового списка прокси.")],
  ["#torToggle", () => t("settings_help_tor", "Добавить локальный Tor в доступные прокси.")],
  ["#warpToggle", () => t("settings_help_warp", "Добавить локальный Cloudflare WARP в доступные прокси.")],
  ["#proxyAdvanced summary", () => t("settings_help_advanced", "Развернуть или свернуть дополнительные ограничения прокси.")],
  ["#ownOnlyToggle", () => t("settings_help_own_only", "Использовать свои прокси только для вручную добавленных сайтов.")],
  ["#httpsOnlyToggle", () => t("settings_help_https", "Не направлять HTTP-сайты через прокси.")],
  ["#secureProxiesOnlyToggle", () => t("settings_help_secure", "Ограничить цепочку прокси защищёнными транспортами.")],
  ["#prohibitDnsToggle", () => t("settings_help_dns", "Запретить DNS-запросы из PAC-скрипта.")],
  ["#proxyOrDieToggle", () => t("settings_help_fail_closed", "Не переходить на прямое соединение при сбое прокси.")],
  ["#moreDomainsToggle", () => t("settings_help_special", "Направлять особые доменные зоны через прокси.")],
  ["#notifPacErrorToggle", () => t("settings_help_notify_pac", "Показывать уведомления об ошибках PAC.")],
  ["#notifExtErrorToggle", () => t("settings_help_notify_ext", "Показывать уведомления об ошибках расширения.")],
  ["#notifNoControlToggle", () => t("settings_help_notify_control", "Сообщать о потере контроля над настройками прокси.")],
  ["[data-category=\"all\"]", () => t("settings_help_logs_all", "Показать записи всех категорий журнала.")],
  ["[data-category=\"network\"]", () => t("settings_help_logs_network", "Показать только сетевые ошибки.")],
  ["[data-category=\"proxy\"]", () => t("settings_help_logs_proxy", "Показать только события прокси.")],
  ["[data-category=\"pac\"]", () => t("settings_help_logs_pac", "Показать только события PAC-скрипта.")],
  ["[data-category=\"auth\"]", () => t("settings_help_logs_auth", "Показать только события авторизации.")],
  ["[data-category=\"system\"]", () => t("settings_help_logs_system", "Показать только системные события.")],
  ["#logsSearchInput", () => t("settings_help_logs_search", "Найти записи журнала по тексту ошибки, домену или URL.")],
  ["#clearLogsSearchBtn", () => t("settings_help_logs_search_clear", "Убрать поисковый запрос и снова показать записи категории.")],
  ["#refreshLogsBtn", () => t("settings_help_logs_refresh", "Заново прочитать записи журнала.")],
  ["#copyLogsBtn", () => t("settings_help_logs_copy", "Скопировать журнал в буфер обмена.")],
  ["#exportLogsBtn", () => t("settings_help_logs_export", "Скачать журнал в текстовый файл.")],
  ["#clearLogsBtn", () => t("settings_help_logs_clear", "Удалить сохранённые записи журнала после подтверждения.")],
  [".log-copy-btn", () => t("settings_help_log_copy", "Скопировать текст и подробности этой записи журнала.")],
  [".log-card:has(.log-details-block)", () => t("settings_help_log_expand", "Показать или скрыть подробности этой записи.")],
  ["#testConnBtn", () => t("settings_help_test", "Проверить связь с PAC-сервером и показать задержку.")],

  ["#viewPacScriptBtn", () => t("settings_help_source", "Открыть код установленного PAC или предпросмотр настроек.")],
  ["#resetSettingsBtn", () => t("settings_help_reset", "Вернуть исходные настройки после подтверждения.")],
  ["#closePacModalBtn", () => t("settings_help_close", "Закрыть просмотр кода PAC без изменения настроек.")],
  ["#appearanceTheme", () => t("settings_help_theme", "Выбрать светлую, тёмную или системную тему.")],
  [".appearance-preset", () => t("settings_help_accent", "Применить этот акцентный цвет интерфейса.")],
  ["#appearanceColor", () => t("settings_help_color", "Выбрать свой акцентный цвет в палитре.")],
  ["#appearanceHex", () => t("settings_help_hex", "Задать свой акцентный цвет кодом #RGB или #RRGGBB.")],
  [".appearance-retry", () => t("settings_help_appearance_retry", "Повторить сохранение выбранного оформления в браузере.")],
  ["#applicationBanner button", () => t("settings_help_apply_retry", "Повторить применение сохранённых настроек браузером.")],
  ["#homeProxyWarningBanner[role=\"button\"],#toast[role=\"button\"]", () => t("settings_help_private", "Открыть настройки разрешения работы в приватных окнах Firefox.")],
];

export function refreshSettingsHelp(root = document) {
  for (const [selector, describe] of HELP) {
    const prefix = root.dataset?.idPrefix;
    const scopedSelector = prefix ? selector.replace(/#([\w-]+)/g, (_match, id) => `#${prefix}${id}`) : selector;
    const nodes = [...root.querySelectorAll(scopedSelector)];
    if (root.matches?.(scopedSelector)) nodes.unshift(root);
    if (!nodes.length) continue;
    const text = describe();
    for (const node of nodes) {
      node.title = text;
      node.setAttribute('aria-description', text);
      // Preserve existing names/validation references; supply missing icon/switch names.
      const hasLabel = [...(node.labels || [])].some(label => label.textContent.trim());
      if (!node.hasAttribute('aria-label') && !hasLabel &&
          (!node.textContent.trim() || node.matches('.icon-btn,.delete-domain-btn,#closePacModalBtn,#clearLogsSearchBtn'))) {
        node.setAttribute('aria-label', text);
      }
      if (node.matches('input[type=checkbox]') && node.closest('label')) {
        node.closest('label').title = text;
      }
    }
  }
}

export function initSettingsHelp() {
  refreshSettingsHelp();
  // Shared history recursively renders its own undo buttons; observe only that small list.
  // No body observer and no per-row listeners. Attribute updates cannot retrigger this.
  for (const id of ['historyList', 'applicationBanner']) {
    const root = document.getElementById(id);
    if (root) new MutationObserver(() => refreshSettingsHelp(root)).observe(root, { childList: true, subtree: true });
  }
}
