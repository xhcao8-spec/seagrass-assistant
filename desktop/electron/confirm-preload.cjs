const { contextBridge, ipcRenderer } = require('electron');

// 原生确认框子窗口的 preload：把「确定/取消」结果回传给主进程。
contextBridge.exposeInMainWorld('confirmBridge', {
  done: (ok) => ipcRenderer.send('confirm-result', Boolean(ok)),
});
