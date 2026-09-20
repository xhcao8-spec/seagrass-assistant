const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('seagrassAssistant', {
  version: '0.1.0',
  hide: () => ipcRenderer.send('assistant:hide'),
  copyToComposer: (payload) => ipcRenderer.invoke('assistant:copy-to-composer', payload),
  listModels: () => ipcRenderer.invoke('assistant:list-models'),
  selectModel: (code) => ipcRenderer.invoke('assistant:select-model', { code }),
  suggest: (payload) => ipcRenderer.invoke('assistant:suggest', payload),
  onContext: (listener) => subscribe('assistant:context', listener),
});
