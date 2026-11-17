'use strict';

import { t } from './i18n.js';

import { clarify, Warning } from './errors-lib.js';

const checkCon = t("msg_there_is_a_network_problem_check_your_connect_855d914d", "Что-то не так с сетью, проверьте соединение.");
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

function decodeUtf8(decoder, value, options) {
  try {
    return decoder.decode(value, options);
  } catch (err) {
    throw clarify(err, t("msg_the_server_response_contains_invalid_utf_8_da_cd4f45e9", "Ответ сервера содержит некорректные данные UTF-8."));
  }
}

export const httpLib = {
  async probe(url, {
    timeoutMs = 10000,
    validateFinalUrl = null,
  } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancelBody = async (response) => {
      if (response?.body && typeof response.body.cancel === 'function') {
        try {
          await response.body.cancel();
        } catch { /* response may already be closed */ }
      }
    };

    const request = async (method) => {
      const options = {
        cache: 'no-store',
        method,
        signal: controller.signal,
      };
      if (method === 'GET') {
        options.headers = new Headers({ Range: 'bytes=0-0' });
      }
      const response = await fetch(url, options);
      if (typeof validateFinalUrl === 'function') {
        const validation = await validateFinalUrl(response.url || url, url);
        if (validation === false || (validation && validation.valid === false)) {
          const message = validation && validation.error
            ? validation.error
            : t("msg_the_final_response_url_failed_the_security_ch_08b72652", "Конечный адрес ответа не прошёл проверку безопасности.");
          await cancelBody(response);
          throw clarify(new Error(message), message);
        }
      }
      return response;
    };

    try {
      let res = await request('HEAD');
      if (res.status === 405 || res.status === 501) {
        await cancelBody(res);
        res = await request('GET');
      }

      const status = res.status;
      if (!((status >= 200 && status < 300) || status === 304)) {
        await cancelBody(res);
        throw clarify(
          new Error(`HTTP ${status}`),
          t("msg_the_server_returned_http_status_sub_5cbb75ba", "Получен ответ с неудачным HTTP-кодом $1.", [status]),
        );
      }

      await cancelBody(res);
      return res;
    } catch (err) {
      if (err instanceof Warning) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw clarify(err, t("msg_the_connection_to_the_server_timed_out_32c34e3b", "Таймаут соединения с сервером."));
      }
      throw clarify(err, checkCon);
    } finally {
      clearTimeout(timer);
    }
  },

  async get(url, {
    timeoutMs = 15000,
    maxBytes = DEFAULT_MAX_BYTES,
    validateFinalUrl = null,
    signal = null,
  } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        cache: 'no-store',
        signal: controller.signal,
      });

      if (typeof validateFinalUrl === 'function') {
        const validation = await validateFinalUrl(res.url || url, url);
        if (validation === false || (validation && validation.valid === false)) {
          const validationMessage = validation && validation.error
            ? validation.error
            : t("msg_the_final_response_url_failed_the_security_ch_08b72652", "Конечный адрес ответа не прошёл проверку безопасности.");
          throw clarify(new Error(validationMessage), validationMessage);
        }
      }

      const status = res.status;
      if (!( (status >= 200 && status < 300) || status === 304 )) {
        throw clarify(
          new Error(`HTTP ${status}`),
          t("msg_the_server_returned_http_status_sub_5cbb75ba", "Получен ответ с неудачным HTTP-кодом $1.", [status])
        );
      }

      const formatLimit = (bytes) => {
        if (bytes >= 1024 * 1024) {
          return t("msg_sub_mb_cfea5b03", "$1 МБ", [(bytes / (1024 * 1024)).toFixed(0)]);
        }
        return t("msg_sub_kb_870dff5f", "$1 КБ", [Math.round(bytes / 1024)]);
      };

      const contentLength = res.headers && res.headers.get && res.headers.get('content-length');
      if (contentLength && Number(contentLength) > maxBytes) {
        throw clarify(
          new Error('Response body too large'),
          t("msg_the_response_exceeds_the_size_limit_sub_77874048", "Размер ответа превышает допустимый лимит ($1).", [formatLimit(maxBytes)])
        );
      }

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let receivedBytes = 0;
        const textChunks = [];

        let reading = true;
        while (reading) {
          const { done, value } = await reader.read();
          if (done) {
            reading = false;
            break;
          }
          receivedBytes += value.length;
          if (receivedBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch { }
            throw clarify(
              new Error('Response body too large'),
              t("msg_the_response_exceeds_the_size_limit_sub_77874048", "Размер ответа превышает допустимый лимит ($1).", [formatLimit(maxBytes)])
            );
          }
          textChunks.push(decodeUtf8(decoder, value, { stream: true }));
        }
        textChunks.push(decodeUtf8(decoder));
        return textChunks.join('');
      }

      if (typeof res.arrayBuffer === 'function') {
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength > maxBytes) {
          throw clarify(
            new Error('Response body too large'),
            t("msg_the_response_exceeds_the_size_limit_sub_77874048", "Размер ответа превышает допустимый лимит ($1).", [formatLimit(maxBytes)])
          );
        }
        return decodeUtf8(new TextDecoder('utf-8', { fatal: true }), buffer);
      }

      // Compatibility fallback for lightweight Response mocks. Native Fetch
      // responses expose body/arrayBuffer and therefore always use strict UTF-8.
      const text = await res.text();
      const textBytes = text ? new TextEncoder().encode(text).byteLength : 0;
      if (textBytes > maxBytes) {
        throw clarify(
          new Error('Response body too large'),
          t("msg_the_response_exceeds_the_size_limit_sub_77874048", "Размер ответа превышает допустимый лимит ($1).", [formatLimit(maxBytes)])
        );
      }
      return text;
    } catch (err) {
      if (err instanceof Warning) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw clarify(err, t("msg_the_connection_to_the_server_timed_out_32c34e3b", "Таймаут соединения с сервером."));
      }
      throw clarify(err, checkCon);
    } finally {
      // Keep the timeout active until the complete response body has been read.
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  },

};
