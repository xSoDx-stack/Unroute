'use strict';

import { t } from './i18n.js';

import { tokenizer } from '../vendor/acorn.mjs';

const OPEN_TO_CLOSE = {
  '(': ')',
  '[': ']',
  '{': '}',
  '${': '}',
};

const CLOSING_TOKENS = new Set(Object.values(OPEN_TO_CLOSE));
// Keep only the last successful source. Settings/resource batches commonly
// reapply that exact PAC; its immutable string does not need another token scan.
let lastValidatedSource = null;
function tokenName(token) {
  if (!token) return '';
  if (token.type.label === 'name') return String(token.value || '');
  return token.type.label;
}

function isDirectFunctionAssignment(tokens) {
  const names = tokens.map(tokenName);
  const joined = names.join(' ');
  return joined.endsWith('FindProxyForURL =') ||
    joined.endsWith('this . FindProxyForURL =') ||
    joined.endsWith('self . FindProxyForURL =') ||
    joined.endsWith('globalThis . FindProxyForURL =');
}

/**
 * Performs a streaming lexical validation of an untrusted PAC source without
 * evaluating it or constructing a potentially huge JavaScript AST.
 *
 * Acorn's tokenizer reliably distinguishes executable identifiers from text in
 * comments, strings, templates and regular expressions. The additional stack
 * check catches truncated responses, while the top-level definition check
 * prevents a comment such as `// FindProxyForURL` from passing validation.
 */
export function validatePacScriptSource(source) {
  if (typeof source !== 'string' || !source.trim()) {
    return { valid: false, error: t("msg_the_pac_script_is_empty_f40d7963", "PAC-скрипт пуст") };
  }
  if (source === lastValidatedSource) return { valid: true };

  const delimiters = [];
  const recentTopLevelTokens = [];
  let assignmentCandidate = false;
  let assignedFunctionAwaitingParams = false;
  let functionParamsDepth = null;
  let functionAwaitingBody = false;
  let hasFindProxyFunction = false;

  try {
    const stream = tokenizer(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
    });

    for (;;) {
      const token = stream.getToken();
      const label = token.type.label;
      if (label === 'eof') break;

      const isTopLevel = delimiters.length === 0;
      if (isTopLevel) {
        if (functionAwaitingBody) {
          if (label === '{') {
            hasFindProxyFunction = true;
          }
          functionAwaitingBody = false;
        }

        recentTopLevelTokens.push(token);
        if (recentTopLevelTokens.length > 6) recentTopLevelTokens.shift();

        const names = recentTopLevelTokens.map(tokenName);
        if (
          names.length >= 3 &&
          names[names.length - 3] === 'function' &&
          names[names.length - 2] === 'FindProxyForURL' &&
          names[names.length - 1] === '('
        ) {
          functionParamsDepth = delimiters.length + 1;
        }

        if (label === '=') {
          assignmentCandidate = isDirectFunctionAssignment(recentTopLevelTokens);
        } else if (assignmentCandidate && label === 'function') {
          assignedFunctionAwaitingParams = true;
          assignmentCandidate = false;
        } else if (assignedFunctionAwaitingParams && label === '(') {
          functionParamsDepth = delimiters.length + 1;
          assignedFunctionAwaitingParams = false;
        } else if (assignmentCandidate && label === '=>') {
          hasFindProxyFunction = true;
          assignmentCandidate = false;
        } else if (label === ';') {
          assignmentCandidate = false;
        }
      } else if (assignmentCandidate && label === '=>') {
        // Parenthesized arrow-function parameters temporarily increase depth;
        // the arrow itself is emitted after the closing parenthesis.
        hasFindProxyFunction = true;
        assignmentCandidate = false;
      }

      if (Object.prototype.hasOwnProperty.call(OPEN_TO_CLOSE, label)) {
        delimiters.push(OPEN_TO_CLOSE[label]);
      } else if (CLOSING_TOKENS.has(label)) {
        const expected = delimiters.pop();
        if (expected !== label) {
            return { valid: false, error: t("msg_the_pac_script_contains_an_unmatched_characte_9e5e2c33", "PAC-скрипт содержит несогласованный символ $1", [label]) };
        }
        if (label === ')' && functionParamsDepth === delimiters.length + 1) {
          functionParamsDepth = null;
          functionAwaitingBody = true;
        }
      }
    }
  } catch (err) {
    return {
      valid: false,
      error: t("msg_the_pac_script_contains_a_syntax_error_sub_85eec82d", "PAC-скрипт содержит синтаксическую ошибку: $1", [err.message || String(err)]),
    };
  }

  if (delimiters.length) {
    return { valid: false, error: t("msg_the_pac_script_is_incomplete_unclosed_bracket_06ee6586", "PAC-скрипт оборван: не закрыты скобки или блоки") };
  }
  if (!hasFindProxyFunction) {
    return { valid: false, error: t("msg_the_response_does_not_contain_an_executable_f_428979a2", "Ответ не содержит исполняемую функцию FindProxyForURL") };
  }

  lastValidatedSource = source;
  return { valid: true };
}
