const {contextBridge, ipcRenderer} = require('electron');


contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  quitApp: () => ipcRenderer.send('quit-app'),
  showDialog: (options) => ipcRenderer.invoke('show-dialog', options),
    // onQuizData: (callback) => ipcRenderer.on('quiz-data', (event, data) => callback(data)),
  onLaunchData: (callback) => ipcRenderer.on('launch-data', (event, data) => callback(data)),
    onTestMessage: (callback) => ipcRenderer.on('test-message', (event, data) => callback(data)),
  getPlatform: () => process.platform,
});
