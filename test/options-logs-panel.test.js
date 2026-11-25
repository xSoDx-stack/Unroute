import assert from 'node:assert/strict';

const element = () => Object.assign(new EventTarget(), { style: {}, value: '', dataset: {} });

async function panel(request) {
  const { initLogsPanel } = await import('../src/common/pages/options/logs-panel.js');
  const fields = { logsNavBadge: element(), logsSearchInput: element(), clearLogsSearchBtn: element(),
    logsLevelSelect: element(), copyLogsBtn: element(), exportLogsBtn: element(), refreshLogsBtn: element() };
  const categories = ['all', 'rules'].map(category => Object.assign(element(), {
    dataset: { category }, classList: { toggle() {} }, setAttribute() {}, querySelector() {},
  }));
  const root = { getElementById: id => fields[id], querySelectorAll: () => categories };
  const toasts = [];
  return { logs: initLogsPanel(root, { request, showToast: message => toasts.push(message) }), fields, toasts, categories };
}

describe('Settings logs panel', () => {
  it('uses the same severity, category and trimmed search for list, copy and export', async () => {
    const requests = [];
    const { logs, fields, categories } = await panel(async message => {
      requests.push(message);
      if (message.action === 'EXPORT_LOGS') return { success: true, data: { count: 0, text: '' } };
      return { success: true, data: { logs: [] } };
    });
    categories[1].dispatchEvent(new Event('click'));
    fields.logsLevelSelect.value = 'warn';
    fields.logsLevelSelect.dispatchEvent(new Event('change'));
    assert.deepEqual(requests.at(-1), { action: 'GET_LOGS', category: 'rules', level: 'warn', search: '', limit: 150 });
    fields.logsSearchInput.value = '  example.test ';
    fields.logsSearchInput.dispatchEvent(new Event('input'));
    fields.copyLogsBtn.dispatchEvent(new Event('click'));
    fields.exportLogsBtn.dispatchEvent(new Event('click'));
    await logs.load();
    const filters = { category: 'rules', level: 'warn', search: 'example.test' };
    assert.deepEqual(requests.slice(-3), [
      { action: 'EXPORT_LOGS', ...filters }, { action: 'EXPORT_LOGS', ...filters },
      { action: 'GET_LOGS', ...filters, limit: 150 },
    ]);
    logs.reset();
    assert.equal(fields.logsLevelSelect.value, 'all');
  });
  it('does not announce empty logs for copy/export cancelled by reset', async () => {
    const { fields, toasts } = await panel(async () => ({ success: false, stale: true }));
    fields.copyLogsBtn.dispatchEvent(new Event('click'));
    fields.exportLogsBtn.dispatchEvent(new Event('click'));
    await Promise.resolve();
    assert.deepEqual(toasts, []);
  });
  it('uses the count for empty exports and reports failed exports separately', async () => {
    let response = { success: true, data: { count: 0, text: 'Report header' } };
    const { fields, toasts } = await panel(async () => response);
    fields.copyLogsBtn.dispatchEvent(new Event('click'));
    await Promise.resolve();
    assert.deepEqual(toasts, ['Нет записей по выбранным фильтрам']);
    response = { success: false };
    fields.exportLogsBtn.dispatchEvent(new Event('click'));
    await Promise.resolve();
    assert.deepEqual(toasts.slice(1), ['Не удалось подготовить записи журнала']);
  });
  it('announces refresh only after the result and distinguishes failure, success and stale', async () => {
    let finish;
    const { fields, toasts } = await panel(() => new Promise(resolve => { finish = resolve; }));
    fields.refreshLogsBtn.dispatchEvent(new Event('click'));
    assert.deepEqual(toasts, []);
    finish({ success: false });
    await Promise.resolve();
    fields.refreshLogsBtn.dispatchEvent(new Event('click'));
    finish({ success: true, data: { logs: [] } });
    await Promise.resolve();
    fields.refreshLogsBtn.dispatchEvent(new Event('click'));
    finish({ success: false, stale: true });
    await Promise.resolve();
    assert.deepEqual(toasts, ['Не удалось обновить журнал', 'Список логов обновлён']);
  });
  it('ignores an older response and keeps the newest navigation badge', async () => {
    const pending = [];
    const { logs, fields } = await panel(message => {
      assert.deepEqual(message, { action: 'GET_LOGS', category: 'all', level: 'all', search: '', limit: 150 });
      return new Promise(resolve => pending.push(resolve));
    });
    const older = logs.load();
    const newer = logs.load();
    pending[1]({ success: true, data: { logs: [], stats: { errors: 2 } } });
    await newer;
    pending[0]({ success: true, data: { logs: [], stats: { errors: 7 } } });
    await older;
    assert.equal(fields.logsNavBadge.textContent, 2);
  });

  it('reset clears search, cancels its debounce and invalidates an in-flight load', async () => {
    let finish;
    let requests = 0;
    const { logs, fields } = await panel(() => {
      requests++;
      return new Promise(resolve => { finish = resolve; });
    });
    const old = logs.load();
    fields.logsSearchInput.value = 'a search';
    fields.logsSearchInput.dispatchEvent(new Event('input'));
    assert.equal(fields.clearLogsSearchBtn.style.display, 'block');
    logs.reset();
    finish({ success: true, data: { logs: [], stats: { errors: 2 } } });
    await old;
    assert.equal(fields.logsSearchInput.value, '');
    assert.equal(fields.clearLogsSearchBtn.style.display, 'none');
    assert.equal(fields.logsNavBadge.style.display, 'none');
    await new Promise(resolve => setTimeout(resolve, 275));
    assert.equal(requests, 1);
  });
});
