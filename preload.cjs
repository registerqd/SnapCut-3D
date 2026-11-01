const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  openSTL: () => ipcRenderer.invoke('dialog:open-stl'),
  saveSTL: (defaultName, arrayBuffer) => ipcRenderer.invoke('dialog:save-stl', { defaultName, arrayBuffer }),
  saveZIP: (defaultName, base64Data) => ipcRenderer.invoke('dialog:save-zip', { defaultName, base64Data })
});
