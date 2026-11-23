'use strict';

// Pont entre la page et le processus principal. Le contexte reste isolé et la
// page n'obtient aucun accès Node : seulement les opérations nécessaires, dont
// les chemins de fichiers sont vérifiés côté main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('globalshareDesktop', {
  isDesktop: true,
  saveDownload: (payload) => ipcRenderer.invoke('globalshare:save-download', payload),
  openDownload: (filePath) => ipcRenderer.invoke('globalshare:open-download', filePath),
  revealDownload: (filePath) => ipcRenderer.invoke('globalshare:reveal-download', filePath),

  // Nombre de transferts actifs : l'arrière-plan (anti-veille système) est
  // maintenu tant que des fichiers circulent, fenêtre fermée ou pas.
  setTransfersActive: (count) => ipcRenderer.invoke('globalshare:set-transfers-active', count),

  // Mises à jour : l'état est poussé par le main, les actions sont demandées
  // par l'interface. Les callbacks sont sans argument côté page.
  getUpdateState: () => ipcRenderer.invoke('globalshare:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('globalshare:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('globalshare:update-download'),
  installUpdate: () => ipcRenderer.invoke('globalshare:update-install'),
  dismissUpdate: () => ipcRenderer.invoke('globalshare:update-dismiss'),
  // Repli quand pkexec/polkit ne peut pas afficher le mot de passe : ouvre le
  // paquet dans le gestionnaire de fichiers (GNOME Software, Discover…).
  openInstaller: () => ipcRenderer.invoke('globalshare:update-open-installer'),
  revealInstaller: () => ipcRenderer.invoke('globalshare:update-reveal-installer'),
  onUpdateState: (listener) => {
    const channel = 'globalshare:update-state';
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onUpdateOpen: (listener) => {
    const channel = 'globalshare:update-open';
    const wrapped = () => listener();
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
