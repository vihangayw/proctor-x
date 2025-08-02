const { app, BrowserWindow, ipcMain, desktopCapturer,dialog } = require('electron')
const path = require('path')

let mainWindow

let deeplinkData = null;
function createWindow() {

  mainWindow = new BrowserWindow({
    // kiosk: true, // True kiosk mode (even more restrictive than fullscreen)
    // alwaysOnTop: false, // Keep window on top of others
    // movable: false, // Prevent window movement
    // minimizable: false, // Disable minimize button
    // maximizable: false, // Disable maximize button
    // closable: true, // Disable close button (use with caution!)
    // titleBarStyle: 'hidden', // Alternative to frame: false on macOS
    // autoHideMenuBar: true ,// Alternative for menu visibility
    width: 1000, // Default width (will be overridden by fullscreen)
    height: 800, // Default height (will be overridden by fullscreen)
    // fullscreen: true, // Enable fullscreen mode
    resizable: true, // Disable window resizing
    frame: true, // Remove window frame (including close/minimize buttons)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
      sandbox: true , // recommended for security
      webSecurity: true, // keep this true unless testing locally
      media: true,
    }
  })

  // Remove application menu
  require('@electron/remote/main').initialize()
  require('@electron/remote/main').enable(mainWindow.webContents)

  app.setAsDefaultProtocolClient('proctorx');

  // Open DevTools in development
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools()
  }
  mainWindow.setMenu(null) // Remove menu bar
  mainWindow.loadFile('index.html')


  mainWindow.webContents.on('did-finish-load', () => {
    if (deeplinkData) {
      mainWindow.webContents.send('launch-data', deeplinkData);
    }
  });
  // Optional: Make sure window stays fullscreen even if user tries to exit
  mainWindow.on('leave-full-screen', () => {
    mainWindow.setFullScreen(true)
  })


}
app.on('open-url', (event, url) => {
  event.preventDefault();
  console.log('Got URL:', url);

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/'); // ['e-quiz', 'quizId', 'studentId', 'uuid']
   console.log(parts)
    if (parts[1] === '56565f34-9e79-4f6e-972e-0aefbfcc111e') {
      const [_,__, quizId, studentId, tkn,sqid] = parts;
      deeplinkData = { quizId, studentId, tkn,sqid };
      if (mainWindow) {
        mainWindow.webContents.send('launch-data', deeplinkData);
      }
    }
  } catch (err) {
    console.error('Invalid URL:', err);
  }
});

app.setAsDefaultProtocolClient('proctorx');
app.on('web-contents-created', (_, contents) => {
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      // Allow camera/mic
      return callback(true);
    }
    callback(false);
  });
});
app.whenReady().then(() => {
  createMainWindow();
});

// Handle second-instance (for Windows)
app.on('second-instance', (event, argv) => {
  const url = argv.find((arg) => arg.startsWith('proctorx://'));
  if (url) {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const [_,quizId, studentId, tkn,sqid ] = parts;
    deeplinkData = { quizId, studentId, tkn,sqid };
    if (mainWindow) {
      mainWindow.webContents.send('launch-data', deeplinkData);
    }
  }
});
// Handle getting screen sources
ipcMain.handle('get-sources', async () => {
  return await desktopCapturer.getSources({ types: ['window', 'screen'] })
})

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
ipcMain.handle('show-dialog', async (_, options) => {
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: ['OK', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Confirm Exit',
    message: options.message || 'Are you sure you want to quit?'
  })
  return result.response // Returns 0 for OK, 1 for Cancel
})

ipcMain.on('quit-app', () => {
  console.log('Quit command received') // Debug log
  try {
    app.quit()
  } catch (error) {
    console.error('Failed to quit:', error)
  }

})

app.whenReady().then(createWindow)
