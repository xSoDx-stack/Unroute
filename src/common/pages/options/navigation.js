const DEFAULT_TAB = 'exceptions';

export function initOptionsNavigation(root, { flushSites, onActivate }) {
  const buttons = [...root.querySelectorAll('.nav-tab-btn')];
  const panels = root.querySelectorAll('.tab-content');
  let activeTab = DEFAULT_TAB;
  let revision = 0;

  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const request = ++revision;
      const tab = button.dataset.tab;
      if (activeTab === DEFAULT_TAB && tab !== DEFAULT_TAB && !await flushSites()) return;
      if (request !== revision) return;

      for (const candidate of buttons) {
        candidate.classList.toggle('active', candidate === button);
        if (candidate === button) candidate.setAttribute('aria-current', 'page');
        else candidate.removeAttribute('aria-current');
      }
      for (const panel of panels) panel.classList.toggle('active', panel.id === `tab-${tab}`);
      activeTab = tab;
      onActivate(tab);
      root.defaultView.history.replaceState(null, '', `#${tab}`);
    });
  }

  const find = tab => buttons.find(button => button.dataset.tab === tab);
  return {
    get activeTab() { return activeTab; },
    open(tab) { find(tab)?.click(); },
    restore(hash) { (find(hash.slice(1)) || find(DEFAULT_TAB))?.click(); },
    invalidate() { ++revision; },
  };
}
