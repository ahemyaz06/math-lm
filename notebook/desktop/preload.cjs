// The only bridge between the page and the computer: menu commands in, chosen files out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notebook', {
  onCommand: (handler) => ipcRenderer.on('command', (_event, name) => handler(name)),
  choosePdf: () => ipcRenderer.invoke('choose-pdf'),
  openNotebook: () => ipcRenderer.invoke('open-notebook'),
  openText: (options) => ipcRenderer.invoke('open-text', options),
  save: (options) => ipcRenderer.invoke('save', options),
  saveBinary: (options) => ipcRenderer.invoke('save-binary', options),
  exportPdf: (options) => ipcRenderer.invoke('export-pdf', options),
  print: () => ipcRenderer.invoke('print'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  readText: () => ipcRenderer.invoke('read-text'),
  setTitle: (title) => ipcRenderer.send('set-title', title),
  getMenu: () => ipcRenderer.invoke('get-menu'),
  setMenuChecked: (id, checked) => ipcRenderer.send('set-menu-checked', id, checked),
});
