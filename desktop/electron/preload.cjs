const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('seagrassDesktop', {
  version: '1.1.0',
  shell: 'electron',
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    checkForUpdates: () => ipcRenderer.invoke('app:check-update'),
    onUpdateState: (listener) => subscribe('app:update-state', listener),
  },
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  local: {
    settings: () => ipcRenderer.invoke('local:settings'),
    saveSettings: (input) => ipcRenderer.invoke('local:save-settings', input),
    test: () => ipcRenderer.invoke('local:test'),
    balance: () => ipcRenderer.invoke('local:balance'),
    proxies: () => ipcRenderer.invoke('local:proxies'),
    createProxy: (input) => ipcRenderer.invoke('local:create-proxy', input),
    deleteProxy: (id) => ipcRenderer.invoke('local:delete-proxy', id),
    testProxy: (id) => ipcRenderer.invoke('local:test-proxy', id),
  },
  system: {
    getSettings: () => ipcRenderer.invoke('system:get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('system:save-settings', settings),
    resetSettings: () => ipcRenderer.invoke('system:reset-settings'),
  },
  confirmDialog: (message) => ipcRenderer.invoke('confirm-dialog', message),
  external: {
    open: (url) => ipcRenderer.invoke('shell:open-external', url),
  },
  platform: {
    open: (config) => ipcRenderer.invoke('platform:open', config),
    list: () => ipcRenderer.invoke('platform:list'),
    profiles: () => ipcRenderer.invoke('platform:profiles'),
    hide: () => ipcRenderer.invoke('platform:hide'),
    conceal: (id) => ipcRenderer.invoke('platform:conceal', id),
    show: (id) => ipcRenderer.invoke('platform:show', id),
    setSidebarCollapsed: (collapsed) => ipcRenderer.invoke('platform:set-sidebar-collapsed', collapsed),
    updateConfig: (id, config) => ipcRenderer.invoke('platform:update-config', id, config),
    close: (id) => ipcRenderer.invoke('platform:close', id),
    delete: (id) => ipcRenderer.invoke('platform:delete', id),
    updateSettings: (id, settings) => ipcRenderer.invoke('platform:update-settings', id, settings),
    testTranslation: (settings) => ipcRenderer.invoke('platform:test-translation', settings),
    onLoadState: (listener) => subscribe('platform:load-state', listener),
  },
  assistant: {
    toggle: (payload = {}) => ipcRenderer.invoke('assistant:inline-toggle', payload),
    hide: () => ipcRenderer.invoke('assistant:inline-hide'),
    listModels: () => ipcRenderer.invoke('assistant:list-models'),
    selectModel: (code) => ipcRenderer.invoke('assistant:select-model', { code }),
    suggest: (payload = {}) => ipcRenderer.invoke('assistant:suggest', payload),
    copyToComposer: (payload = {}) => ipcRenderer.invoke('assistant:copy-to-composer', payload),
    onContext: (listener) => subscribe('assistant:context', listener),
  },
});
