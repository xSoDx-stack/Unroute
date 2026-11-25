'use strict';

import { t } from './i18n.js';
import { parse } from '../vendor/acorn.mjs';

const ENTRY = 'FindProxyForURL';
let lastValidatedSource = null;

export function clearPacValidationCache() {
  lastValidatedSource = null;
}

const isEntry = node => node?.type === 'Identifier' && node.name === ENTRY;
const isFunction = node => Boolean(node && !node.async && !node.generator &&
  (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'));
const isWrapper = node => node?.type === 'CallExpression' && !node.optional && isFunction(node.callee) &&
  node.callee.params.length === 0;

function producesFunction(node) {
  if (isFunction(node)) return true;
  if (!isWrapper(node)) return false;
  const body = node.callee.body;
  if (body.type !== 'BlockStatement') return isFunction(body);
  const statements = body.body.filter(statement => !statement.directive);
  return statements.length === 1 && statements[0].type === 'ReturnStatement' && isFunction(statements[0].argument);
}

function bindingNames(pattern, names) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') names.add(pattern.name);
  else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, names);
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument, names);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(item => bindingNames(item, names));
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(item => bindingNames(item.value || item, names));
}

function publishesEntry(node, names, nested = false) {
  if (node?.type !== 'AssignmentExpression' || node.operator !== '=' || !producesFunction(node.right)) return false;
  const target = node.left;
  if (!nested && isEntry(target)) return true;
  return target.type === 'MemberExpression' && !target.computed && isEntry(target.property) &&
    (target.object.type === 'Identifier' && ['self', 'globalThis'].includes(target.object.name) && !names.has(target.object.name) ||
      !nested && target.object.type === 'ThisExpression');
}

function declaresEntry(statement, names) {
  if (statement.type === 'FunctionDeclaration') return !statement.async && !statement.generator && isEntry(statement.id);
  if (statement.type === 'VariableDeclaration') {
    return statement.declarations.some(declaration => isEntry(declaration.id) && producesFunction(declaration.init));
  }
  if (statement.type !== 'ExpressionStatement') return false;
  const expression = statement.expression;
  if (publishesEntry(expression, names)) return true;
  if (!isWrapper(expression)) return false;
  const body = expression.callee.body;
  const localNames = expression.callee.id ? new Set([...names, expression.callee.id.name]) : names;
  if (body.type !== 'BlockStatement') return publishesEntry(body, localNames, true);
  const statements = body.body.filter(item => !item.directive);
  return statements.length === 1 && statements[0].type === 'ExpressionStatement' &&
    publishesEntry(statements[0].expression, localNames, true);
}

/** Check syntax and supported entry-point forms without executing provider code. */
export function validatePacScriptSource(source) {
  if (typeof source !== 'string' || !source.trim()) {
    return { valid: false, error: t('msg_the_pac_script_is_empty_f40d7963', 'PAC-скрипт пуст') };
  }
  if (source === lastValidatedSource) return { valid: true };

  try {
    const program = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    const names = new Set();
    for (const statement of program.body) {
      if (statement.type === 'VariableDeclaration') {
        statement.declarations.forEach(declaration => bindingNames(declaration.id, names));
      } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
        bindingNames(statement.id, names);
      }
    }
    if (!program.body.some(statement => declaresEntry(statement, names))) {
      return { valid: false, error: t('msg_the_response_does_not_contain_an_executable_f_428979a2', 'Ответ не содержит исполняемую функцию FindProxyForURL') };
    }
  } catch (error) {
    return { valid: false, error: t('msg_the_pac_script_contains_a_syntax_error_sub_85eec82d',
      'PAC-скрипт содержит синтаксическую ошибку: $1', [error.message || String(error)]) };
  }

  lastValidatedSource = source;
  return { valid: true };
}