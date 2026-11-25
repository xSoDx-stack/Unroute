const PAC_MODS_STORAGE_KEY = 'pac-kitchen-mods';
const PROXY_HEALTH_STORAGE_KEY = 'proxy-health-cache';

export function createOptionsState({
  appState, request, applySettingsState, render, preloadLogStats, formatVersion,
  getManifestVersion = () => '',
}) {
  let readRevision = 0;
  let resetGeneration = 0;
  let settingsStateRevision = 0;
  let syncStateRevision = 0;
  let externalTimer = null;
  let externalPending = false;
  let scheduleExternalRefresh;

  function publishSettingsState(state) {
    ++settingsStateRevision;
    applySettingsState(state);
  }

  function setSyncState(state) {
    ++syncStateRevision;
    appState.syncState = state;
  }

  const requestSafely = message => request(message).catch(error => ({ success: false, error: error.message }));

  async function sendMessage(message, isCurrent = () => true) {
    const generation = resetGeneration;
    const response = await requestSafely(message);
    if (generation !== resetGeneration || !isCurrent()) return { success: false, stale: true };
    if (!response.stale && response.settingsState) {
      publishSettingsState(response.settingsState);
    }
    return response;
  }

  async function refresh({ preloadLogs = false } = {}) {
    const revision = ++readRevision;
    const statusRevision = settingsStateRevision;
    const syncRevision = syncStateRevision;
    const response = await requestSafely({ action: 'GET_STATE', includeExceptions: false });
    if (response.stale || revision !== readRevision) return false;
    const data = response.success && response.data;
    if (data) {
      let pacMods = data.pacMods || appState.pacMods;
      if (!Array.isArray(pacMods.proxyCatalog)) {
        const catalog = await requestSafely({ action: 'GET_EXCEPTIONS' });
        if (revision !== readRevision) return false;
        if (catalog.success && Array.isArray(catalog.data?.proxyCatalog)) {
          pacMods = { ...pacMods, proxyCatalog: catalog.data.proxyCatalog, defaultProxyId: catalog.data.defaultProxyId };
        }
      }
      Object.assign(appState, {
        syncState: (syncRevision === syncStateRevision && data.syncState) || appState.syncState,
        pacMods,
        notifications: data.notifications || appState.notifications,
        version: formatVersion(data.version || getManifestVersion()),
        proxyHealthMap: data.proxyHealthMap || {},
      });
    }
    if (response.settingsState && statusRevision === settingsStateRevision) {
      publishSettingsState(response.settingsState);
    }
    if (data) render();

    if (preloadLogs) preloadLogStats().catch(() => {});
    return Boolean(data);
  }

  function watchExternal({ document, changesEvent, isBusy, isResetBusy = () => false, sitesEditor, isSitesActive }) {
    const canRefresh = () => !isBusy() && document.visibilityState === 'visible';
    scheduleExternalRefresh = () => {
      externalPending = true;
      clearTimeout(externalTimer);
      externalTimer = null;
      if (!canRefresh()) return;
      externalTimer = setTimeout(() => {
        externalTimer = null;
        if (!canRefresh()) return;
        externalPending = false;
        refresh().catch(() => {});
        if (isSitesActive()) sitesEditor.refresh();
      }, 50);
    };

    changesEvent?.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes) return;
      if (!Object.hasOwn(changes, PAC_MODS_STORAGE_KEY) && !changes[PROXY_HEALTH_STORAGE_KEY] && !changes['settings-application']) return;
      // Reset owns invalidation and readback. Coalesce storage events until it settles.
      if (isResetBusy()) { scheduleExternalRefresh(); return; }
      const modsChange = changes[PAC_MODS_STORAGE_KEY];
      if (modsChange) {
        const { oldValue, newValue } = modsChange;
        if (!newValue || !oldValue || (newValue._revision || 0) < (oldValue._revision || 0)) sitesEditor.invalidate();
        else if ((newValue._rulesRevision ?? newValue._revision ?? 0) !==
                 (oldValue._rulesRevision ?? oldValue._revision ?? 0)) sitesEditor.cancelRead();
      }
      scheduleExternalRefresh();
    });
    document.defaultView.addEventListener('focus', scheduleExternalRefresh);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleExternalRefresh();
    });
  }

  return {
    sendMessage, refresh, watchExternal, publishSettingsState, setSyncState,
    getResetGeneration: () => resetGeneration,
    invalidateRead() { ++readRevision; },
    resumeExternalRefresh() { if (externalPending) scheduleExternalRefresh(); },
    reset() {
      ++resetGeneration;
      ++readRevision;
      clearTimeout(externalTimer);
      externalTimer = null;
      externalPending = false;
    },
  };
}
