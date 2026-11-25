import assert from 'node:assert/strict';
import { initHistoryPanel } from '../src/common/pages/options/history-panel.js';

describe('Settings history panel', () => {
  it('does not notify or reload when a clear response is stale', async () => {
    const button = new EventTarget();
    const container = { replaceChildren() {} };
    const messages = [];
    const notifications = [];
    let settle;
    initHistoryPanel({
      defaultView: { confirm: () => true },
      getElementById: id => ({ clearHistoryBtn: button, historyList: container })[id],
    }, {
      request(message) {
        messages.push(message);
        return new Promise(resolve => { settle = resolve; });
      },
      notify: text => notifications.push(text),
    });
    const oldChrome = globalThis.chrome;
    globalThis.chrome = { runtime: { sendMessage(message, reply) {
      messages.push(message);
      reply({ success: true, data: [] });
    } } };
    try {
      button.dispatchEvent(new Event('click'));
      settle({ success: false, stale: true });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(messages, [{ action: 'CLEAR_RULE_HISTORY' }]);
      assert.deepEqual(notifications, []);
    } finally {
      globalThis.chrome = oldChrome;
    }
  });
});
