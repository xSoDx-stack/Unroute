'use strict';

export const FIREFOX_PRIVATE_BROWSING_REQUIRED_ERROR_CODE =
  'FIREFOX_PRIVATE_BROWSING_REQUIRED';

export class Warning extends Error {
  constructor(message = 'Warning') {
    super(message);
    this.name = 'Warning';
  }
}

export function clarify(err, message, { data } = {}) {
  if (!err) {
    return err;
  }
  const warn = new Warning(message);
  warn.wrapped = err;
  if (data) {
    warn.data = data;
  }
  return warn;
}

function* errorChain(err) {
  const seen = new Set();
  for (let current = err; current && !seen.has(current) && seen.size < 32; current = current.wrapped) {
    seen.add(current);
    yield current;
  }
}

export function formatErrorMessage(err) {
  const messages = [];
  for (const current of errorChain(err)) {
    let text;
    try { text = current.message || (typeof current === 'object' ? JSON.stringify(current) : String(current)); }
    catch { text = '[Unserializable error]'; }
    if (text && messages.at(-1) !== text) messages.push(text);
  }
  return messages.join(' > ');
}

export function getErrorCode(err) {
  for (const current of errorChain(err)) {
    if (typeof current.code === 'string' && current.code) {
      return current.code;
    }
  }
  return '';
}
