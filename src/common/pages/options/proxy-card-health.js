import { t, uiLocale } from '../../core/i18n.js';

const PROXY_HEALTH_FRESH_MS = 15 * 60 * 1000;

export function isProxyHealthFresh(health, now = Date.now()) {
  const checkedAt = Number(health?.checkedAt);
  return Number.isFinite(checkedAt) && checkedAt > 0 && now - checkedAt <= PROXY_HEALTH_FRESH_MS;
}

export function renderProxyCardHealth(status, recheck, health) {
  let className, text, title = '';
  const checkedAt = Number(health.checkedAt);
  const checkedAtText = Number.isFinite(checkedAt) && checkedAt > 0
    ? new Date(checkedAt).toLocaleString(uiLocale())
    : '';
  const isStale = typeof health.ok === 'boolean' && !isProxyHealthFresh(health);
  if (health.checking) {
    className = 'proxy-status-tag checking';
    text = t("msg_checking_60762acf", "Проверка");
  } else if (health.ok === true) {
    className = `proxy-status-tag ${isStale ? 'stale' : 'online'}`;
    const latency = Number.isFinite(health.latency) ? t("msg_sub_ms_485532ae", "$1 мс", [health.latency]) : t("msg_available_d81568b8", "Доступен");
    title = checkedAtText
      ? t("msg_latency_sub_last_checked_sub_sub_08f10410", "Задержка: $1. Последняя проверка: $2$3", [latency, checkedAtText, isStale ? t("msg_the_result_may_be_out_of_date_824db2ef", ". Результат мог устареть") : ''])
      : t("msg_latency_sub_a8827757", "Задержка: $1", [latency]);
    text = latency;
  } else if (health.ok === false) {
    className = `proxy-status-tag ${isStale ? 'stale' : 'offline'}`;
    const errorText = health.error || t("msg_unavailable_53ba89ac", "Недоступен");
    title = checkedAtText
      ? t("msg_sub_last_checked_sub_sub_31650300", "$1. Последняя проверка: $2$3", [errorText, checkedAtText, isStale ? t("msg_the_result_may_be_out_of_date_824db2ef", ". Результат мог устареть") : ''])
      : errorText;
    text = isStale ? t("msg_no_connection_ee60619b", "Нет связи") : t("msg_unavailable_0a1f9ba9", "Недоступен");
  } else {
    className = 'proxy-status-tag unchecked';
    text = t("msg_not_checked_f951698d", "Не проверен");
  }
  if (status.className !== className) status.className = className;
  if (status.textContent !== text) status.textContent = text;
  if (status.title !== title) status.title = title;
  const checking = Boolean(health.checking);
  if (recheck.disabled !== checking || !recheck.hasAttribute('aria-busy')) {
    recheck.classList.toggle('is-checking', checking);
    recheck.disabled = checking;
    recheck.setAttribute('aria-busy', String(checking));
  }
}
