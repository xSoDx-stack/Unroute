import { expect } from 'chai';
const ui = await import('../src/common/pages/options/portable-settings.js').catch(() => ({}));

describe('Portable settings isolated UI', () => {
  function setup(overrides = {}) {
    const nodes = new Map(['portable-export', 'portable-import', 'portable-file', 'portable-warning', 'portable-status'].map(id => [id, Object.assign(new EventTarget(), { disabled: false, value: '', textContent: '', files: [], click() {} })]));
    const calls = [], messages = [], downloads = [];
    const api = ui.initPortableSettings({ root: { getElementById: id => nodes.get(id) },
      request: async message => { calls.push(message); return message.action === 'EXPORT_SETTINGS' ? { success: true, data: { includesPasswords: true } } :
        { success: true, data: { saved: true, applied: false, pending: true, settingsState: { pending: true } } }; },
      showToast: message => messages.push(message), confirm: async () => true,
      download: (...args) => downloads.push(args), ...overrides });
    return { api, calls, messages, downloads, nodes };
  }
  it('requires a visible password warning and confirmation before exporting plain JSON', async () => {
    expect(ui.initPortableSettings).to.be.a('function');
    const view = setup();
    expect(view.nodes.get('portable-warning').textContent).to.match(/парол|password/i);
    await view.api.exportSettings();
    expect(view.calls).to.deep.equal([{ action: 'EXPORT_SETTINGS' }]);
    expect(view.downloads[0][0]).to.equal('{\n  "includesPasswords": true\n}\n');
    const denied = setup({ confirm: async () => false }); await denied.api.exportSettings();
    expect(denied.calls).to.have.length(0);
  });
  it('does not request an export after destruction during confirmation', async () => {
    let approve;
    const view = setup({ confirm: () => new Promise(resolve => { approve = resolve; }) });
    const pending = view.api.exportSettings();
    view.api.destroy();
    approve(true);
    await pending;
    expect(view.calls).to.have.length(0);
  });
  it('does not download or notify after destruction during the request', async () => {
    let reply;
    const view = setup({ request: () => new Promise(resolve => { reply = resolve; }) });
    const pending = view.api.exportSettings();
    await Promise.resolve();
    view.api.destroy();
    reply({ success: true, data: {} });
    await pending;
    expect(view.downloads).to.have.length(0);
    expect(view.messages).to.have.length(0);
  });
  it('sends original file text without altering passwords and reports pending instead of applied', async () => {
    expect(ui.initPortableSettings).to.be.a('function');
    let imported;
    const view = setup({ onImported: result => { imported = result; } });
    const raw = '{"password":"  fixture%20  "}';
    await view.api.importFile({ size: raw.length, text: async () => raw });
    expect(view.calls).to.deep.equal([{ action: 'IMPORT_SETTINGS', backup: raw }]);
    expect(imported).to.include({ saved: true, pending: true });
    expect(view.messages.at(-1)).to.match(/ожида|pending/i);
    expect(view.nodes.get('portable-file').value).to.equal('');
  });
  it('rejects oversize files locally and never displays credential-bearing server errors', async () => {
    expect(ui.initPortableSettings).to.be.a('function');
    let reads = 0;
    const view = setup(); await view.api.importFile({ size: 65 * 1024 * 1024, text: async () => { reads++; return ''; } });
    expect(reads).to.equal(0); expect(view.calls).to.have.length(0);
    const failed = setup({ request: async () => { throw new Error('fixture-secret'); } });
    await failed.api.exportSettings(); expect(failed.messages.join(' ')).not.to.include('fixture-secret');
  });
});
