const {contextBridge, ipcRenderer} = require('electron');


contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  quitApp: () => ipcRenderer.send('quit-app'),
  showDialog: (options) => ipcRenderer.invoke('show-dialog', options),
  showWarningDialog: (options) => ipcRenderer.send('show-warning-dialog', options),
    // onQuizData: (callback) => ipcRenderer.on('quiz-data', (event, data) => callback(data)),
  onLaunchData: (callback) => ipcRenderer.on('launch-data', (event, data) => callback(data)),
    onTestMessage: (callback) => ipcRenderer.on('test-message', (event, data) => callback(data)),
  onLmsConnectionError: (callback) => ipcRenderer.on('lms-connection-error', (event, data) => callback(data)),
  onShowWarningDialog: (callback) => ipcRenderer.on('show-warning-dialog', (event, data) => callback(data)),
  onShowSweetAlertWarning: (callback) => ipcRenderer.on('show-sweetalert-warning', (event, data) => callback(data)),
  onShowSweetAlertConfirm: (callback) => ipcRenderer.on('show-sweetalert-confirm', (event, data) => callback(data)),
  onShowSweetAlertDialog: (callback) => ipcRenderer.on('show-sweetalert-dialog', (event, data) => callback(data)),
  onShowSweetAlertMultipleDisplay: (callback) => ipcRenderer.on('show-sweetalert-multiple-display', (event, data) => callback(data)),
  onCloseMultipleDisplayAlert: (callback) => ipcRenderer.on('close-multiple-display-alert', (event) => callback()),
  notifyMultipleDisplayAlertShown: () => ipcRenderer.send('multiple-display-alert-shown'),
  notifyMultipleDisplayAlertClosed: () => ipcRenderer.send('multiple-display-alert-closed'),
  sendSweetAlertResponse: (confirmed) => ipcRenderer.send('sweetalert-dialog-response', confirmed),
  sendSweetAlertConfirmResponse: (confirmed) => ipcRenderer.send('sweetalert-confirm-response', confirmed),
  restoreWindowState: () => ipcRenderer.send('restore-window-state'),
  getPlatform: () => process.platform,
    // Add method to get display media stream from Electron
    getDisplayMedia: () => ipcRenderer.invoke('get-display-media'),
  // Status bar APIs
  getBatteryStatus: () => ipcRenderer.invoke('get-battery-status'),
  getNetworkStatus: () => ipcRenderer.invoke('get-network-status'),
  onBatteryStatusUpdate: (callback) => ipcRenderer.on('battery-status-update', (event, data) => callback(data)),
  onNetworkStatusUpdate: (callback) => ipcRenderer.on('network-status-update', (event, data) => callback(data)),
});
