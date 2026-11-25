'use strict';

import { appState } from './core/app-state.js';
import { pacSync } from './core/pac-sync.js';
import { setupAuthListener } from './core/proxy-auth.js';
import { blockInformer } from './core/block-informer.js';
import { errorHandlers } from './core/error-handlers.js';
import { setupContextMenus, createContextMenuItems } from './core/context-menus.js';
import { setupMessageBus, captureSettingsGeneration } from './core/message-bus.js';
import { proxyBackend } from './core/proxy-backend.js';
import { siteResources } from './core/site-resources.js';
import { tabProxyRouter } from './core/tab-proxy-router.js';
import { whenProxySettingsIdle } from './core/proxy-settings-lock.js';
import { toolbarBadge } from './core/toolbar-badge.js';

// 1. Setup messaging, auth listener, context menus, and event listeners synchronously at top level
setupMessageBus();
setupAuthListener(() => appState.ensureProxyAuthInitialized(), () => appState.ensureLoggerInitialized());
setupContextMenus();
errorHandlers.setupListeners(async () => {
  await appState.ensureStorageAccessRestricted();
  await Promise.all([appState.ensureLoggerInitialized(), appState.ensureErrorHandlersInitialized()]);
});
blockInformer.init();
siteResources.setup();
tabProxyRouter.setup();
toolbarBadge.setup();

// 2. Alarms listener for background periodic synchronization (ensuring state is initialized)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'periodic-pac-update') {
    const isCurrent = captureSettingsGeneration();
    if (!isCurrent()) return;
    try {
      await appState.ensureInitialized();
      if (!isCurrent()) return;
      await pacSync.syncWithPacProvider({ ifUnattended: true });
    } catch (err) {
      console.warn('[Periodic PAC Update Warning]:', err);
    }
  }
});

// Detect when a policy or another extension takes over the profile-wide
// proxy setting after Unroute has already started.
proxyBackend.addSettingsChangeListener(async () => {
  // A health probe owns a temporary PAC until its queued restore completes.
  // Reconcile the final native state instead of recovering over that probe.
  const isCurrent = captureSettingsGeneration();
  if (!isCurrent()) return;
  try {
    await whenProxySettingsIdle();
    if (!isCurrent()) return;
    await appState.ensureInitialized();
    if (!isCurrent()) return;
    await pacSync.reconcileProxyState();
    if (isCurrent()) toolbarBadge.schedule();
  } catch (err) { console.warn('[Proxy Control State Warning]:', err); }
});

// 4. Extension Installed / Updated
chrome.runtime.onInstalled.addListener(async (details) => {
  createContextMenuItems();
  try {
    await appState.ensureInitialized();
  } catch (err) {
    console.warn('[Service Worker] onInstalled initialization error:', err);
  }

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/options/index.html') });
  }
});

// 5. Browser Startup
chrome.runtime.onStartup.addListener(async () => {
  try {
    await appState.ensureInitialized();
  } catch (err) {
    console.warn('[Service Worker] onStartup initialization error:', err);
  }
});

// 6. Enforce the storage boundary on wake. Restore state at its consumers.
appState.ensureStorageAccessRestricted().catch((err) => {
  console.warn('[Service Worker] Storage access restriction warning:', err);
});
