# Политика приватности АнтиЧебурнет / AntiCheburnet Privacy Policy

Обновлено: 2 октября 2026 года.

АнтиЧебурнет настраивает выборочную маршрутизацию браузера через PAC и прокси. Проект: https://github.com/xSoDx-stack/runet-censorship-bypass. Вопросы о приватности можно направлять через раздел Issues этого репозитория. Не публикуйте там пароли, личные адреса или неочищенные журналы.

## Данные на устройстве

Настройки, правила доменов, загруженный PAC, адреса прокси и введённые для них логины и пароли сохраняются в локальном хранилище расширения. Пароли не шифруются самим расширением. Доступ к профилю браузера может дать доступ к этим данным.

Адрес текущей вкладки и сетевые события обрабатываются для выбора правила и индикации прокси. Диагностический журнал содержит до 150 последних записей, включая домены неудачных запросов в обычных окнах. Состояние маршрутов вкладок временно хранится в памяти и сессионном хранилище. Сетевые события приватных вкладок не добавляются в эту статистику и журнал; события авторизации таких запросов также не журналируются. Прокси продолжает работать в приватных окнах. Правила, которые пользователь явно сохраняет в настройках, являются общими для профиля.

Автоматической отправки журналов, истории посещений, аналитики или рекламных идентификаторов разработчику нет. Журналы и списки доменов экспортируются в файл только по команде пользователя. Перед передачей экспортированных данных проверьте их содержимое: маскирование известных форматов секретов не гарантирует удаление любых личных сведений.

## Сетевые обращения и получатели

Для списка ресурсов расширение наблюдает адреса запросов обычных вкладок и временно хранит до 300 доменов на вкладку (до 100 вкладок) в сессионном хранилище. Только в Chromium и при настроенном собственном прокси, Tor или WARP новые домены ресурсов сайта с ручным правилом автоматически записываются в обычные постоянные правила; существующие правила сохраняются до явного переключения всего набора. Такие правила глобальны и остаются до удаления пользователем. В Firefox ресурсы в постоянные списки не добавляются: при наличии собственного прокси правило основного сайта применяется к запросам конкретной вкладки. Для этого основной домен вкладки, в том числе приватной, держится только в памяти до закрытия вкладки или фонового обработчика. Ресурсы приватных вкладок не собираются в статистику. Содержимое запросов и ответов не сохраняется.

- PAC загружается с выбранного источника: серверов «Антизапрета» (`e.cen.rodeo`, `antizapret.prostovpn.org`), «Антицензорити» (`anticensority.github.io`, `raw.githubusercontent.com`) либо адреса пользователя. Источник получает обычные сведения о соединении, в том числе IP-адрес и запрос файла. Активный PAC периодически обновляется в фоне.
- Выбранные PAC или пользователем прокси передают браузерный трафик. Их операторы могут видеть IP-адрес подключения, адреса назначения и метаданные; при незашифрованном HTTP также содержимое запросов и ответов. HTTPS к сайту защищает содержимое соединения, но не скрывает все метаданные от прокси. Расширение не является системным VPN и не гарантирует анонимность.
- Логин и пароль прокси передаются браузером только для авторизации на соответствующем настроенном прокси. HTTP-прокси не обеспечивает шифрования соединения с самим прокси; для передачи учётных данных через внешнюю сеть используйте доверенный HTTPS-прокси.
- Добавление или проверка прокси вызывает пробный запрос к Cloudflare (`https://1.1.1.1/cdn-cgi/trace`) через этот прокси. Проверка соединения также может обращаться к выбранному PAC-источнику. Локальные Tor/WARP и другие локальные прокси проверяются при использовании соответствующей функции.
- По отдельной команде открываются внешние сервисы: Роскомнадзор получает домен в форме проверки после ручной отправки; Google Translate и Internet Archive получают URL выбранной страницы; реестр Роскомсвободы получает домен. При открытии страницы сервиса он также получает обычные сведения о соединении. CAPTCHA Роскомнадзора и отправка формы остаются под контролем пользователя.

Операторы этих сервисов и прокси самостоятельно определяют обработку и сроки хранения получаемых ими данных. Расширение не контролирует их серверные журналы. Собственные серверы сбора пользовательских данных, продажа данных и использование их для рекламы в проекте не предусмотрены.

## Контроль и удаление

Выберите «Отключить» во вкладке PAC, чтобы расширение освободило настройки прокси. Вы можете изменить источник и прокси, удалить доменные правила, очистить журнал или сбросить настройки. Удаление расширения удаляет его локальное хранилище средствами браузера; ранее экспортированные файлы нужно удалить отдельно. Срок хранения настроек ограничивается их удалением или сбросом пользователем; журнал ограничен количеством записей. Для вопросов используйте Issues проекта.

Данные используются только для заявленных функций маршрутизации и диагностики. Использование данных соответствует ограничениям Chrome Web Store User Data Policy, включая Limited Use: данные не продаются и не используются для рекламы, оценки кредитоспособности или иных несвязанных целей.

## English

The resource list temporarily records up to 300 resource hostnames per ordinary tab, for up to 100 tabs, in session storage. In Chromium, only with a configured own proxy, Tor or WARP, newly discovered resources of a site with an explicit rule are saved as ordinary persistent global rules; existing rules are retained until an explicit whole-site switch. Saved rules remain until removed by the user. Firefox does not add resource hosts to persistent lists: with an own proxy configured, the main-site rule controls requests belonging to that tab. Its main hostname, including for private tabs, is kept only in memory until the tab or background context closes. Private resource hosts are not collected for statistics. Request and response bodies are not recorded.

AntiCheburnet configures selective browser proxy routing using PAC scripts. Settings, domain rules, downloaded PAC scripts, proxy addresses and proxy credentials are stored locally. Credentials are not encrypted by the extension. A local diagnostic log keeps up to 150 entries and may contain failed-request domains from ordinary windows. Per-tab route information is held in memory and session storage. Private-tab network events are excluded from these statistics and logs, and their proxy-authentication events are not logged. Explicitly saved settings apply to the entire profile.

There is no automatic developer telemetry, advertising or upload of browsing history or logs. Exports are initiated by the user and must be checked before sharing. Known secret formats are masked, but exported diagnostics can still contain personal information.

The selected PAC provider receives file requests and normal connection metadata, including an IP address. PAC sources are the Antizapret and Anticensority hosts listed above or a user-configured URL; active PAC files are refreshed in the background. Traffic selected by PAC or user rules passes through third-party proxies. Proxy operators can observe destination addresses and connection metadata, and unencrypted HTTP content. Configured proxy credentials are sent to the matching proxy for authentication. An HTTP proxy does not encrypt its connection; use a trusted HTTPS proxy when transmitting credentials over an external network. This extension is not a system VPN and does not guarantee anonymity.

Proxy checks contact Cloudflare at `https://1.1.1.1/cdn-cgi/trace`; connectivity checks may contact the selected PAC source. User-initiated context-menu commands send the selected page URL to Google Translate or Internet Archive, or its domain to a registry service. The Roskomnadzor form is prefilled with a domain; CAPTCHA and submission are manual. These third parties have their own data-handling and retention practices, which the extension does not control.

Users can disable PAC routing, change providers, delete rules, clear logs, reset settings or uninstall the extension. Exported files remain until separately deleted. No data is sold or used for advertising or unrelated purposes. Use of data complies with the Chrome Web Store User Data Policy, including Limited Use. Contact: https://github.com/xSoDx-stack/runet-censorship-bypass/issues (do not post secrets or personal browsing data).
