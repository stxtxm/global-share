'use strict';

// Pont minimal entre la page et le processus principal. Le contexte reste
// isolé et la page n'obtient aucun accès Node : seulement trois appels, dont
// deux vérifient que le chemin demandé est bien dans le dossier de l'app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('globalshareDesktop', {
  isDesktop: true,
  saveDownload: (payload) => ipcRenderer.invoke('globalshare:save-download', payload),
  openDownload: (filePath) => ipcRenderer.invoke('globalshare:open-download', filePath),
  revealDownload: (filePath) => ipcRenderer.invoke('globalshare:reveal-download', filePath),
});
