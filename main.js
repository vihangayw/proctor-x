const {app, BrowserWindow, ipcMain, desktopCapturer, dialog, nativeImage, session} = require('electron')
const path = require('path')
const remoteMain = require('@electron/remote/main');
const {globalShortcut} = require('electron');

// Enable screen capture in Electron
app.commandLine.appendSwitch('enable-usermedia-screen-capturing')
app.commandLine.appendSwitch('allow-http-screen-capture')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')

let mainWindow

let deeplinkData = null;

remoteMain.initialize();

function createWindow() {

    let iconPath;
    const platform = process.platform;


    if (platform === 'win32') {
        iconPath = path.join(__dirname, 'assets', 'icon.ico');
    } else if (platform === 'darwin') {
        iconPath = path.join(__dirname, 'assets', 'icon.icns');
    } else {
        iconPath = path.join(__dirname, 'assets', 'icon.png');
    }

    if (process.platform === 'darwin') {
        const icon = nativeImage.createFromPath(
            path.join(__dirname, 'assets', 'icon.png') // Use high-res PNG (e.g., 512x512)
        );
        app.dock.setIcon(icon);
    }
    mainWindow = new BrowserWindow({
        // kiosk: true, // True kiosk mode (even more restrictive than fullscreen)
        // alwaysOnTop: true, // Keep window on top of others
        movable: false, // Prevent window movement
        minimizable: false, // Disable minimize button
        maximizable: false, // Disable maximize button
        closable: true, // Enable close button
        titleBarStyle: 'hidden', // Alternative to frame: false on macOS
        autoHideMenuBar: true,// Alternative for menu visibility
        width: 1000, // Default width (will be overridden by fullscreen)
        height: 800, // Default height (will be overridden by fullscreen)
        fullscreen: true, // Enable fullscreen mode
        resizable: false, // Disable window resizing
        frame: false, // Remove window frame (including close/minimize buttons)
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            enableRemoteModule: false,
            sandbox: false, // Disable sandbox for screen sharing
            webSecurity: false, // Disable for development to allow getDisplayMedia
            allowRunningInsecureContent: true,
            experimentalFeatures: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            // ✅ Required for screen capture
            media: {
                audio: true,
                video: true,
                videoCapture: true,
                audioCapture: true,
            },
            // webSecurity: true,
            // ✅ These two flags are critical:
            permissions: ['display-capture'],
            // allowRunningInsecureContent: false,
        },
        icon: iconPath
    })

    // Remove application menu
    const remoteMain = require('@electron/remote/main');
    remoteMain.enable(mainWindow.webContents);

    app.setAsDefaultProtocolClient('proctorx');

    // Open DevTools in development
    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools()
    }
    mainWindow.setMenu(null) // Remove menu bar
    mainWindow.loadFile('index.html')


    mainWindow.webContents.on('did-finish-load', () => {
        console.log('Window finished loading, checking for deeplink data...');
        if (deeplinkData) {
            console.log('Found deeplink data, sending to renderer...');
            mainWindow.webContents.send('launch-data', deeplinkData);
            console.log('Launch data sent from did-finish-load handler');
        } else {
            console.log('No deeplink data available yet');
        }
    });
    // Optional: Make sure window stays fullscreen even if user tries to exit
    mainWindow.on('leave-full-screen', () => {
        mainWindow.setFullScreen(true)
    })
    mainWindow.webContents.on('before-input-event', (event, input) => {
        // Block Ctrl+Shift+I, F12, or Cmd+Opt+I on macOS
        const devToolShortcuts = (
            (input.key === 'I' && input.control && input.shift) || // Ctrl+Shift+I
            (input.key === 'F12') ||
            (input.meta && input.alt && input.key === 'I')         // Cmd+Opt+I
        );

        if (devToolShortcuts) {
            event.preventDefault();
        }
    });
    mainWindow.webContents.session.setPermissionCheckHandler(() => true);
    mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
        if (permission === 'media' || permission === 'display-capture') cb(true);
        else cb(false);
    });

    // Handle window close with confirmation dialog
    mainWindow.on('close', (event) => {
        event.preventDefault(); // Prevent default close behavior

        dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['Yes, Exit', 'Cancel'],
            defaultId: 1, // Default to Cancel
            cancelId: 1,
            title: 'Exit ProctorX',
            message: 'Are you sure you want to exit application?',
            detail: 'This will close the application completely and you will need to restart it to continue.'
        }).then((result) => {
            if (result.response === 0) { // User clicked "Yes, Exit"
                // Force quit the application completely
                app.exit(0);
            }
            // If user clicked Cancel, do nothing (window stays open)
        }).catch((err) => {
            console.error('Error showing exit dialog:', err);
            // If dialog fails, allow close
            app.exit(0);
        });
    });

}

app.on('open-url', (event, url) => {
    event.preventDefault();
    console.log('Got URL:', url);

    try {
        const parsed = new URL(url);
        const parts = parsed.pathname.split('/').filter(Boolean); // Remove empty strings
        console.log('URL parts:', parts);

        // Expected structure: ['hardcodedId', 'quizId', 'studentId', 'token', 'studentQuizId']
        // The 'e-quiz' is part of the hostname, not pathname
        if (parts.length >= 5) {
            const [hardcodedId, quizId, studentId, tkn, studentQuizId] = parts;
            deeplinkData = {quizId, studentId, tkn, sqid: studentQuizId};
            console.log('Parsed deeplink data:', deeplinkData);
            
            if (mainWindow) {
                console.log('Main window found, sending data...');
                // Focus the window
                if (mainWindow.isMinimized()) {
                    console.log('Window was minimized, restoring...');
                    mainWindow.restore();
                }
                mainWindow.focus();
                console.log('Window focused');

                // Send data when window is ready
                if (mainWindow.webContents.isLoading()) {
                    console.log('Window is still loading, waiting for did-finish-load...');
                    mainWindow.webContents.once('did-finish-load', () => {
                        console.log('Window finished loading, sending launch data...');
                        mainWindow.webContents.send('launch-data', deeplinkData);
                        console.log('Launch data sent successfully');
                    });
                } else {
                    console.log('Window already loaded, sending launch data immediately...');
                    // Send a test message first to verify IPC is working
                    mainWindow.webContents.send('test-message', 'IPC test from main process');
                    mainWindow.webContents.send('launch-data', deeplinkData);
                    console.log('Launch data sent successfully');
                }
            } else {
                console.error('Main window not found');
            }
        } else {
            console.error('Invalid URL structure. Expected: proctorx://e-quiz/quizId/studentId/sequence/token/sqid');
        }
    } catch (err) {
        console.error('Invalid URL:', err);
    }
});

app.setAsDefaultProtocolClient('proctorx');
app.on('web-contents-created', (_, contents) => {
    contents.session.setPermissionCheckHandler((webContents, permission) => {
        // if (permission === 'display-capture') return true;
        return true;
    });

    contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media' || permission === 'display-capture') {
            // Allow camera/mic and screen capture
            return callback(true);
        }
        callback(false);
    });
});

app.whenReady().then(() => {
    globalShortcut.register('CommandOrControl+Shift+Q', () => {
        // Show confirmation dialog before quitting
        if (mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'question',
                buttons: ['Yes, Exit', 'Cancel'],
                defaultId: 1, // Default to Cancel
                cancelId: 1,
                title: 'Exit ProctorX',
                message: 'Are you sure you want to exit application?',
                detail: 'This will close the application completely and you will need to restart it to continue.'
            }).then((result) => {
                if (result.response === 0) { // User clicked "Yes, Exit"
                    app.exit(0);
                }
            }).catch((err) => {
                console.error('Error showing exit dialog:', err);
                app.exit(0);
            });
        } else {
            app.exit(0);
        }
    });
});
app.whenReady().then(() => {
    app.setAsDefaultProtocolClient('proctorx');

    app.on('activate', () => {
        // Don't create new windows on activate - let the app stay closed
        // if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

});

// Handle second-instance (for Windows)
app.on('second-instance', (event, argv) => {
    const url = argv.find((arg) => arg.startsWith('proctorx://'));
    if (url) {
        console.log('Second instance URL:', url);
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean);
            console.log('Second instance URL parts:', parts);

            // Expected structure: ['hardcodedId', 'quizId', 'studentId', 'token', 'studentQuizId']
            // The 'e-quiz' is part of the hostname, not pathname
            if (parts.length >= 5) {
                const [hardcodedId, quizId, studentId, tkn, studentQuizId] = parts;
                deeplinkData = {quizId, studentId, tkn, sqid: studentQuizId};
                console.log('Second instance parsed deeplink data:', deeplinkData);

                if (mainWindow) {
                    console.log('Main window found, focusing and sending data...');
                    // Focus the existing window
                    if (mainWindow.isMinimized()) {
                        console.log('Window was minimized, restoring...');
                        mainWindow.restore();
                    }
                    mainWindow.focus();
                    console.log('Window focused');

                    // Send data when window is ready
                    if (mainWindow.webContents.isLoading()) {
                        console.log('Window is still loading, waiting for did-finish-load...');
                        mainWindow.webContents.once('did-finish-load', () => {
                            console.log('Window finished loading, sending launch data...');
                            mainWindow.webContents.send('launch-data', deeplinkData);
                            console.log('Launch data sent successfully');
                        });
                    } else {
                        console.log('Window already loaded, sending launch data immediately...');
                        mainWindow.webContents.send('launch-data', deeplinkData);
                        console.log('Launch data sent successfully');
                    }
                } else {
                    console.error('Main window not found in second instance');
                }
            } else {
                console.error('Invalid URL structure in second instance. Expected: proctorx://e-quiz/quizId/studentId/sequence/token/sqid');
            }
        } catch (err) {
            console.error('Invalid URL in second instance:', err);
        }
    }
});
// Handle getting screen sources
ipcMain.handle('get-sources', async () => {
    return await desktopCapturer.getSources({types: ['window', 'screen']})
})

// Handle getting display media stream
ipcMain.handle('get-display-media', async () => {
    try {
        const sources = await desktopCapturer.getSources({types: ['screen']});
        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }

        // Get the first screen source
        const source = sources[0];

        // Create a stream using getUserMedia with the screen source
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: source.id,
                    minWidth: 1280,
                    maxWidth: 1280,
                    minHeight: 720,
                    maxHeight: 720,
                    maxFrameRate: 15,
                }
            }
        });

        return stream;
    } catch (error) {
        console.error('Error getting display media:', error);
        throw error;
    }
})

// Quit when all windows are closed - force quit completely
app.on('window-all-closed', () => {
    // Force quit the application completely on all platforms
    app.exit(0);
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
