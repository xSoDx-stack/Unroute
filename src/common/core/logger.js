'use strict';

import { t, uiLocale } from './i18n.js';

import { storage } from './storage.js';

const STORAGE_LOGS_KEY = 'antiCensorLogs';
const MAX_LOGS_LIMIT = 150;
const DUPLICATE_WINDOW_MS = 10000;
const IMMEDIATE_SAVE_INTERVAL_MS = 1000;
const LOG_LEVELS = new Set(['error', 'warn', 'info']);
const LOG_CATEGORIES = new Set(['network', 'proxy', 'pac', 'auth', 'system', 'rules', 'settings', 'backup']);

/**
 * Sanitize strings to redact passwords, auth credentials, tokens, and cookies
 * @param {string} str 
 * @returns {string} Sanitized string
 */
export function sanitizeLogString(str) {
  if (!str || typeof str !== 'string') return str;

  return str
    // Proxy directives accept unescaped punctuation in user info. Use the
    // last @ in the directive before its host and numeric port.
    .replace(/(\b(?:HTTPS?|PROXY|SOCKS[45]?|QUIC)\s+)[^\s:;]+:[^\s;]+(@(?:\[[0-9a-f:.]+\]|[\w.-]+):\d+)/gi,
      '$1***:***$2')
    // Mask user:pass@host in proxy or URL strings (e.g. HTTPS user:password@host:port)
    .replace(/([a-zA-Z0-9+.-]+:\/\/)?([^:\s/@]+):([^@\s/]+)@/g, (match, proto) => {
      const p = proto || '';
      return `${p}***:***@`;
    })
    // Mask Basic authentication
    .replace(/(Authorization:\s*Basic\s+)[^\s]+/gi, '$1***')
    .replace(/(Basic\s+)[a-zA-Z0-9+/=]{10,}/gi, '$1***')
    // Mask Bearer tokens
    .replace(/(Bearer\s+)[a-zA-Z0-9._~+/-]{10,}/gi, '$1***')
    // Mask cookie headers and JSON/form-style secrets copied into diagnostics
    .replace(/((?:set-cookie|cookie):\s*)[^\r\n]+/gi, '$1***')
    .replace(/(["']?(?:password|pass|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^"'\s,;&]+)/gi,
      (_, key, value) => key + (/^["']/.test(value) ? `${value[0]}***${value[0]}` : '***'))
    // Mask URL query params with credentials
    .replace(/([?&](?:password|pass|pwd|token|access_token|refresh_token|secret|client_secret|auth|key|api_key|apiKey|cookie|session)=)[^&#\s]+/gi, '$1***');
}

/**
 * Recursively sanitize objects, arrays, and primitives to remove sensitive data
 * @param {any} data 
 * @returns {any} Cleaned, sanitized data
 */
export function sanitizeLogData(data) {
  return sanitizeValue(data, new WeakSet(), 0);
}

function sanitizeValue(data, ancestors, depth) {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return sanitizeLogString(data);
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return data;
  }

  if (typeof data === 'object') {
    if (ancestors.has(data)) return '[Circular]';
    if (depth >= 32) return '[Truncated]';
    ancestors.add(data);
    const SENSITIVE_KEYS = /^(password|pass|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|session(?:id)?|auth|authorization|cookie|cookies|set-cookie|credentials|proxycredentials|rawauth)$/i;
    try {
      return Array.isArray(data) ? data.map(item => sanitizeValue(item, ancestors, depth + 1)) :
        Object.fromEntries(Object.entries(data).map(([key, value]) =>
          [key, SENSITIVE_KEYS.test(key) ? '***' : sanitizeValue(value, ancestors, depth + 1)]));
    } finally {
      ancestors.delete(data);
    }
  }

  return sanitizeLogString(String(data));
}

function freezeLogData(data) {
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) freezeLogData(value);
    Object.freeze(data);
  }
  return data;
}

function cleanLogEntry({ id, timestamp, level, category, title, message, details, groupKey, count }) {
  let cleanDetails = null;
  if (details != null) {
    try {
      cleanDetails = typeof details === 'object' ? freezeLogData(sanitizeLogData(details)) : sanitizeLogString(String(details));
    } catch {
      cleanDetails = '[Unavailable]';
    }
  }
  return Object.freeze({
    id: typeof id === 'string' ? sanitizeLogString(id) : '',
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    level: LOG_LEVELS.has(level) ? level : 'error',
    category: LOG_CATEGORIES.has(category) ? category : 'system',
    title: sanitizeLogString(String(title || t("msg_unknown_error_2d55ddef", "Неизвестная ошибка"))),
    message: sanitizeLogString(String(message || '')),
    details: cleanDetails,
    groupKey: sanitizeLogString(String(groupKey || '')),
    ...(Number.isSafeInteger(count) && count > 1 ? { count } : {}),
  });
}

/**
 * Structured Logging & Diagnostics Engine for Manifest V3
 */
class LoggerManager {
  #logs = [];
  #initPromise = null;
  #generation = 0;

  constructor() {
    this.saveTimeout = null;
    this.savePromise = Promise.resolve();
    this.lastImmediateSaveAt = 0;
    this.isInitialized = false;
  }

  init() {
    if (this.isInitialized) return Promise.resolve();
    if (this.#initPromise) return this.#initPromise;
    const generation = this.#generation;
    this.#initPromise = this.savePromise.catch(() => {}).then(async () => {
      if (generation !== this.#generation) return;
      try {
        const saved = await storage.get(STORAGE_LOGS_KEY, []);
        if (generation !== this.#generation) return;
        if (Array.isArray(saved)) {
          const restored = saved.slice(0, MAX_LOGS_LIMIT - this.#logs.length)
            .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
            .map(cleanLogEntry);
          this.#logs.push(...restored);
        }
      } catch (err) {
        console.warn('[Logger] Failed to restore logs from storage:', err);
      }
      if (generation === this.#generation) this.isInitialized = true;
    });
    return this.#initPromise;
  }

  /**
   * Add a new log entry with automatic sanitization
   * @param {Object} entry
   * @param {'error'|'warn'|'info'} [entry.level='error']
   * @param {'network'|'proxy'|'pac'|'auth'|'system'|'rules'|'settings'|'backup'} [entry.category='system']
   * @param {string} entry.title
   * @param {string} [entry.message='']
   * @param {any} [entry.details=null]
   * @param {string} [entry.groupKey=''] Optional key for precise aggregation
   */
  add({ level = 'error', category = 'system', title = '', message = '', details = null, groupKey = '' }) {
    const timestamp = Date.now();
    const id = `${timestamp}-${Math.random().toString(36).slice(2, 7)}`;
    const logEntry = cleanLogEntry({ id, timestamp, level, category, title, message, details, groupKey });
    const recent = this.#logs[0];
    if (
      recent &&
      recent.level === logEntry.level &&
      recent.category === logEntry.category &&
      recent.title === logEntry.title &&
      recent.message === logEntry.message &&
      (recent.groupKey || '') === logEntry.groupKey &&
      timestamp - recent.timestamp < DUPLICATE_WINDOW_MS
    ) {
      const repeated = Object.freeze({ ...recent, count: (recent.count || 1) + 1, timestamp });
      this.#logs[0] = repeated;
      this.scheduleSave(logEntry.level === 'error');
      return repeated;
    }

    // Newest entry added to the top; maintain MAX_LOGS_LIMIT
    this.#logs.unshift(logEntry);
    if (this.#logs.length > MAX_LOGS_LIMIT) this.#logs.pop();

    this.scheduleSave(logEntry.level === 'error');
    return logEntry;
  }

  error(category, title, message, details, groupKey = '') {
    return this.add({ level: 'error', category, title, message, details, groupKey });
  }

  warn(category, title, message, details, groupKey = '') {
    return this.add({ level: 'warn', category, title, message, details, groupKey });
  }

  info(category, title, message, details, groupKey = '') {
    return this.add({ level: 'info', category, title, message, details, groupKey });
  }

  /**
   * Persistence to storage (immediate for errors, debounced for non-critical logs)
   */
  scheduleSave(immediate = false) {
    clearTimeout(this.saveTimeout);
    const now = Date.now();
    if (immediate && now - this.lastImmediateSaveAt >= IMMEDIATE_SAVE_INTERVAL_MS) {
      this.saveTimeout = null;
      this.lastImmediateSaveAt = now;
      this.queueSave();
      return;
    }

    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.queueSave();
    }, 400);
  }

  queueSave() {
    const generation = this.#generation;
    // Entries and details are immutable and already sanitized. A cold save
    // must wait for the stored history to be merged before taking a snapshot.
    const snapshot = this.isInitialized ? this.#logs.slice() : null;
    const ready = snapshot ? null : this.init();
    return this.#enqueueWrite(async () => {
      if (generation !== this.#generation) return;
      if (ready) await ready;
      if (generation !== this.#generation) return;
      try {
        await storage.set(STORAGE_LOGS_KEY, snapshot ?? this.#logs.slice());
      } catch (err) {
        console.warn('[Logger] Failed to save logs to storage:', err);
      }
    });
  }

  #enqueueWrite(write) {
    this.savePromise = this.savePromise.catch(() => {}).then(write);
    return this.savePromise;
  }

  /**
   * Get filtered logs
   */
  getLogs({ category = 'all', level = 'all', search = '', limit = 150 } = {}) {
    let result = this.#logs;

    if (category && category !== 'all') {
      result = result.filter((log) => log.category === category);
    }

    if (level && level !== 'all') {
      result = result.filter((log) => log.level === level);
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((log) => {
        const inTitle = (log.title || '').toLowerCase().includes(q);
        const inMessage = (log.message || '').toLowerCase().includes(q);
        const inDetails = log.details ? JSON.stringify(log.details).toLowerCase().includes(q) : false;
        return inTitle || inMessage || inDetails;
      });
    }

    return result.slice(0, limit);
  }

  /**
   * Get log counters by category & level
   */
  getStats() {
    const stats = {
      total: this.#logs.length,
      ...Object.fromEntries(Array.from(LOG_CATEGORIES, category => [category, 0])),
      errors: 0,
      warnings: 0,
      info: 0,
    };

    for (const log of this.#logs) {
      stats[log.category]++;
      if (log.level === 'error') stats.errors++;
      else if (log.level === 'warn') stats.warnings++;
      else if (log.level === 'info') stats.info++;
    }

    return stats;
  }

  /**
   * Clear all stored logs
   */
  async clear() {
    this.resetRuntimeState();
    this.isInitialized = true;
    await this.#enqueueWrite(() => storage.set(STORAGE_LOGS_KEY, []));
    return true;
  }

  resetRuntimeState() {
    this.#generation++;
    this.#initPromise = null;
    this.#logs = [];
    clearTimeout(this.saveTimeout);
    this.saveTimeout = null;
    this.lastImmediateSaveAt = 0;
    this.isInitialized = false;
  }

  /**
   * Export logs as a clean, sanitized text report
   */
  exportText(category = 'all', search = '') {
    return this.exportReport({ category, search }).text;
  }

  exportReport({ category, level, search } = {}) {
    const logs = this.getLogs({ category, level, search, limit: MAX_LOGS_LIMIT });
    if (!logs.length) {
      return { count: 0, text: t("msg_the_error_log_is_empty_fc25b18e", "# Журнал ошибок и сбоев пуст.\n") };
    }

    let report = `=======================================================\n`;
    report += t("msg_unroute_error_report_1566112b", " Отчёт об ошибках и сбоях расширения «Unroute»\n", []);
    report += t("msg_exported_sub_7272ca57", " Дата выгрузки: $1\n", [new Date().toLocaleString(uiLocale())]);
    report += t("msg_total_entries_sub_8989df5a", " Всего записей в отчете: $1\n", [logs.length]);
    report += `=======================================================\n\n`;

    logs.forEach((item, index) => {
      const timeStr = new Date(item.timestamp).toLocaleString(uiLocale());
      const countStr = item.count > 1 ? t("msg_repeated_sub_times_0ea8e23d", " (повторено $1 раз)", [item.count]) : '';
      report += `[${index + 1}] [${timeStr}] [${item.level.toUpperCase()}] [${item.category.toUpperCase()}]${countStr}\n`;
      report += t("msg_title_sub_e7ebd829", "  Заголовок: $1\n", [sanitizeLogString(item.title)]);
      if (item.message) {
        report += t("msg_message_sub_6f3fc7d3", "  Сообщение: $1\n", [sanitizeLogString(item.message)]);
      }
      if (item.details) {
        const sanitizedDetails = sanitizeLogData(item.details);
        report += t("msg_details_sub_2074c648", "  Детали: $1\n", [typeof sanitizedDetails === 'object' ? JSON.stringify(sanitizedDetails, null, 2) : sanitizedDetails]);
      }
      report += `-------------------------------------------------------\n`;
    });

    return { count: logs.length, text: report };
  }
}

export const logger = new LoggerManager();
