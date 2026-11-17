'use strict';

import { t, uiLocale } from '../../core/i18n.js';
import { refreshSettingsHelp } from './settings-help.js';

import { formatLogEntryForClipboard } from '../../core/log-format.js';

export async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('Clipboard API unavailable');
}

export function renderLogsView(el, logsState, showToast) {
  const { items, stats } = logsState;

  // Update Nav Badge
  if (el.logsNavBadge) {
    const errorCount = (stats && stats.errors) || 0;
    if (errorCount > 0) {
      el.logsNavBadge.textContent = errorCount > 99 ? '99+' : errorCount;
      el.logsNavBadge.style.display = 'inline-flex';
    } else {
      el.logsNavBadge.style.display = 'none';
    }
  }

  // Update Total Records Pill
  if (el.logsTotalCountPill) {
    const total = (stats && stats.total) !== undefined ? stats.total : items.length;
    el.logsTotalCountPill.textContent = `${total} ${getPluralRecords(total)}`;
  }

  // Update Filter Category Counters
  if (el.countNetwork) el.countNetwork.textContent = stats.network ? `(${stats.network})` : '';
  if (el.countProxy) el.countProxy.textContent = stats.proxy ? `(${stats.proxy})` : '';
  if (el.countPac) el.countPac.textContent = stats.pac ? `(${stats.pac})` : '';
  if (el.countAuth) el.countAuth.textContent = stats.auth ? `(${stats.auth})` : '';
  if (el.countSystem) el.countSystem.textContent = stats.system ? `(${stats.system})` : '';

  if (!el.logsContainer) return;

  if (!items.length) {
    const isFiltered = logsState.category !== 'all' || Boolean(logsState.search.trim());
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';

    const title = document.createElement('p');
    title.style.fontSize = '14.5px';
    title.style.fontWeight = '600';
    title.style.marginBottom = '4px';
    title.textContent = isFiltered
      ? t("msg_no_entries_match_the_filter_65bb1c4c", "🔍 Записей по фильтру не найдено")
      : t("msg_no_errors_recorded_0986be50", "🛡️ Ошибок не зафиксировано");

    const description = document.createElement('p');
    description.style.fontSize = '11.5px';
    description.style.color = 'var(--text-muted)';
    description.textContent = isFiltered
      ? t("msg_try_changing_the_category_or_clearing_the_sea_5ae7e689", "Попробуйте изменить категорию или очистить поисковый запрос")
      : t("msg_network_requests_proxies_and_pac_scripts_are__8ccd866d", "Все сетевые запросы, прокси и PAC-скрипты работают в штатном режиме");

    emptyState.appendChild(title);
    emptyState.appendChild(description);
    el.logsContainer.textContent = '';
    el.logsContainer.appendChild(emptyState);
    return;
  }

  el.logsContainer.innerHTML = '';
  const categoryLabels = {
    network: t("msg_network_f3f1c8f5", "🌐 Сеть"),
    proxy: t("msg_proxy_b93fd429", "⚙️ Прокси"),
    pac: '⚡ PAC',
    auth: '🔒 Auth',
    system: t("msg_system_6d0c6b0c", "💻 Система"),
  };

  items.forEach((log) => {
    const card = document.createElement('div');
    const level = log.level || 'error';
    card.className = `log-card level-${level}`;

    const date = new Date(log.timestamp);
    const timeFormatted = date.toLocaleTimeString(uiLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const levelBadgeText = level === 'error' ? t("msg_error_bf22dfee", "Ошибка") : level === 'warn' ? t("msg_warning_233a8e99", "Предупреждение") : t("msg_info_3319b9b0", "Инфо");
    const catText = categoryLabels[log.category] || log.category;

    const header = document.createElement('div');
    header.className = 'log-card-header';

    const badges = document.createElement('div');
    badges.className = 'log-card-badges';

    const levelBadge = document.createElement('span');
    levelBadge.className = `log-badge ${level}`;
    levelBadge.textContent = levelBadgeText;
    badges.appendChild(levelBadge);

    const catBadge = document.createElement('span');
    catBadge.className = 'category-tag';
    catBadge.textContent = catText;
    badges.appendChild(catBadge);

    if (log.count > 1) {
      const repeatBadge = document.createElement('span');
      repeatBadge.className = 'log-repeat-badge';
      repeatBadge.title = t("msg_repeated_sub_times_1b3c0c12", "Число повторений: $1", [log.count]);
      repeatBadge.textContent = `×${log.count}`;
      badges.appendChild(repeatBadge);
    }
    header.appendChild(badges);

    const headerActions = document.createElement('div');
    headerActions.className = 'log-card-actions';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.title = date.toLocaleString(uiLocale());
    timeSpan.textContent = `🕒 ${timeFormatted}`;
    headerActions.appendChild(timeSpan);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'log-copy-btn';
    copyButton.title = t("msg_copy_this_entry_21bc6d3d", "Скопировать эту запись");
    copyButton.setAttribute('aria-label', t("msg_copy_this_log_entry_3c7795fa", "Скопировать эту запись журнала"));
    copyButton.textContent = '⧉';
    headerActions.appendChild(copyButton);
    header.appendChild(headerActions);

    card.appendChild(header);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'log-card-title';
    titleDiv.textContent = log.title || '';
    card.appendChild(titleDiv);

    if (log.message) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'log-card-message';
      msgDiv.textContent = log.message;
      card.appendChild(msgDiv);
    }

    let detailsJson = '';
    if (log.details) {
      try {
        detailsJson = typeof log.details === 'object' ? JSON.stringify(log.details, null, 2) : String(log.details);
      } catch {
        detailsJson = String(log.details);
      }
    }

    if (detailsJson) {
      const hint = document.createElement('div');
      hint.className = 'log-expand-hint';
      hint.textContent = t("msg_click_to_show_details_29a1b869", "▶ Нажмите, чтобы посмотреть подробности");
      card.appendChild(hint);

      const detailsBlock = document.createElement('div');
      detailsBlock.className = 'log-details-block';
      detailsBlock.textContent = detailsJson;
      card.appendChild(detailsBlock);

      card.addEventListener('click', () => {
        card.classList.toggle('expanded');
        hint.textContent = card.classList.contains('expanded')
          ? t("msg_hide_details_00917413", "▼ Скрыть подробности")
          : t("msg_click_to_show_details_29a1b869", "▶ Нажмите, чтобы посмотреть подробности");
      });
    }

    copyButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await copyText(formatLogEntryForClipboard(log, detailsJson));
        copyButton.classList.add('copied');
        copyButton.textContent = '✓';
        showToast(t("msg_entry_copied_10769687", "✓ Запись скопирована"));
        setTimeout(() => {
          copyButton.classList.remove('copied');
          copyButton.textContent = '⧉';
        }, 900);
      } catch {
        showToast(t("msg_failed_to_copy_the_entry_3957d21c", "Не удалось скопировать запись"));
      }
    });

    refreshSettingsHelp(card);
    el.logsContainer.appendChild(card);
  });
}


function getPluralRecords(n) {
  const form = new Intl.PluralRules(uiLocale()).select(n);
  if (form === 'one') return t("msg_entry_7422f459", "запись");
  if (form === 'few') return t("msg_entries_d216291a", "записи");
  return t("msg_entries_e4b0dea7", "записей");
}
