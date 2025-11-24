const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, nativeImage, session, screen } = require('electron')
const path = require('path')
const remoteMain = require('@electron/remote/main');
const { globalShortcut } = require('electron');

// Enable screen capture in Electron
app.commandLine.appendSwitch('enable-usermedia-screen-capturing')
app.commandLine.appendSwitch('allow-http-screen-capture')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('disable-site-isolation-trials')

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
        kiosk: true, // True kiosk mode (even more restrictive than fullscreen)
        alwaysOnTop: true, // Keep window on top of others
        movable: false, // Prevent window movement
        minimizable: false, // Disable minimize button
        maximizable: false, // Disable maximize button
        closable: false, // Enable close button
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
    
    // Windows-specific: Hide from taskbar and set additional properties
    if (process.platform === 'win32') {
        // Hide window from taskbar immediately
        mainWindow.setSkipTaskbar(true);
    }
    
    // Ensure window is shown (important for kiosk mode on Windows)
    mainWindow.once('ready-to-show', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            // Windows-specific: Ensure fullscreen and hide taskbar BEFORE showing
            if (process.platform === 'win32') {
                // Set fullscreen and hide taskbar before showing window
                mainWindow.setSkipTaskbar(true);
                mainWindow.setFullScreen(true);
                mainWindow.setAlwaysOnTop(true);
            }
            
            mainWindow.show();
            mainWindow.focus();
            
            // Additional Windows-specific setup after window is shown
            // Use multiple attempts to ensure taskbar is hidden and window is on top
            if (process.platform === 'win32') {
                // Immediate setup - right after show()
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.setSkipTaskbar(true);
                    mainWindow.setFullScreen(true);
                    mainWindow.setAlwaysOnTop(true);
                    mainWindow.focus();
                }
                
                // First attempt after a brief delay
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(true);
                        mainWindow.setFullScreen(true);
                        mainWindow.setAlwaysOnTop(true);
                        mainWindow.focus();
                    }
                }, 50);
                
                // Second attempt to ensure it sticks
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(true);
                        mainWindow.setFullScreen(true);
                        mainWindow.setAlwaysOnTop(true);
                        mainWindow.focus();
                    }
                }, 200);
                
                // Third attempt for stubborn cases
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(true);
                        mainWindow.setFullScreen(true);
                        mainWindow.setAlwaysOnTop(true);
                        mainWindow.focus();
                    }
                }, 500);
                
                // Fourth attempt for very stubborn cases
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(true);
                        mainWindow.setFullScreen(true);
                        mainWindow.setAlwaysOnTop(true);
                        mainWindow.focus();
                    }
                }, 1000);
            }
        }
    });
    
    mainWindow.loadFile('index.html')


    mainWindow.webContents.on('did-finish-load', () => {
        console.log('Window finished loading, checking for deeplink data...');

        // Check for multiple displays
        const displays = screen.getAllDisplays();
        console.log(`Detected ${displays.length} display(s)`);
        if (displays.length >= 2) {
            // Show SweetAlert warning via IPC
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('show-sweetalert-warning', {
                    title: 'Multiple Displays Detected',
                    text: `Warning: ${displays.length} display(s) detected. This application requires a single display setup. Please disconnect additional displays before continuing.`,
                    icon: 'warning',
                    confirmButtonText: 'OK'
                });
            }
        }

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
    
    // Windows-specific: Keep window focused and on top
    if (process.platform === 'win32') {
        let focusInterval = null;
        // Store dialogShowing flag on mainWindow so it's accessible from all scopes
        mainWindow._dialogShowing = false;
        let lastBlurTime = 0; // Track when blur occurred
        
        // Wait for window to be ready before setting up focus management
        mainWindow.once('ready-to-show', () => {
            // Monitor window focus and keep it on top
            mainWindow.on('blur', () => {
                const now = Date.now();
                lastBlurTime = now;
                
                // Show warning dialog if Windows key was likely pressed (window lost focus)
                // Only show dialog if one isn't already showing and it's been at least 2 seconds since last dialog
                if (!mainWindow._dialogShowing && (now - (mainWindow._lastDialogTime || 0)) > 2000) {
                    mainWindow._dialogShowing = true;
                    mainWindow._lastDialogTime = now;
                    
                    // Show warning dialog via SweetAlert
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('show-sweetalert-warning', {
                            title: 'Unauthorized Action Detected',
                            text: 'Windows key or unauthorized action detected. You are not allowed to access other applications or the Windows Start menu during the exam. Please remain focused on the exam application.',
                            icon: 'warning',
                            confirmButtonText: 'OK',
                            allowOutsideClick: false,
                            allowEscapeKey: false
                        });
                    }
                    
                    // Dialog close will be handled in renderer via IPC
                    // Set a timeout to reset dialog flag after reasonable time
                    setTimeout(() => {
                        mainWindow._dialogShowing = false;
                    }, 5000); // Reset after 5 seconds if not already reset
                }
                
                // Immediately refocus the window if it loses focus (closes Start menu if opened)
                // BUT: Don't refocus if a dialog is showing (allows user to click OK button)
                // Use multiple timeouts to catch different scenarios
               
            });
            
            // Prevent window from being minimized
            mainWindow.on('minimize', (event) => {
                event.preventDefault();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try {
                        mainWindow.restore();
                        mainWindow.focus();
                    } catch (error) {
                        console.error('Error restoring window:', error);
                    }
                }
            });
            
            // Keep window always on top and hide taskbar (start immediately to ensure proper initial state)
            // Start checking right away, but also set up immediately
            if (process.platform === 'win32') {
                // Immediate check and setup
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.setSkipTaskbar(true);
                    mainWindow.setFullScreen(true);
                    mainWindow.setAlwaysOnTop(true);
                    mainWindow.focus();
                }
            }
            
            setTimeout(() => {
                focusInterval = setInterval(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        try {
                            // Hide from taskbar continuously
                            mainWindow.setSkipTaskbar(true);
                            
                            if (!mainWindow.isFocused()) {
                                mainWindow.focus();
                            }
                            if (!mainWindow.isAlwaysOnTop()) {
                                mainWindow.setAlwaysOnTop(true);
                            }
                            if (!mainWindow.isFullScreen()) {
                                mainWindow.setFullScreen(true);
                            }
                            
                            // Ensure window covers entire screen including taskbar area
                            const primaryDisplay = screen.getPrimaryDisplay();
                            const currentBounds = mainWindow.getBounds();
                            const screenBounds = primaryDisplay.bounds;
                            
                            // If window doesn't cover full screen, resize it
                            // if (currentBounds.width !== screenBounds.width || 
                            //     currentBounds.height !== screenBounds.height ||
                            //     currentBounds.x !== screenBounds.x ||
                            //     currentBounds.y !== screenBounds.y) {
                            //     mainWindow.setBounds(screenBounds);
                            // }
                        } catch (error) {
                            console.error('Error maintaining window state:', error);
                        }
                    } else {
                        // Clean up interval if window is destroyed
                        if (focusInterval) {
                            clearInterval(focusInterval);
                            focusInterval = null;
                        }
                    }
                }, 500); // Check every 500ms (more aggressive to prevent taskbar access)
            }, 100); // Start checking after 100ms (reduced from 1000ms for faster initial setup)
        });
        
        // Additional aggressive blocking: Monitor for Windows key presses at lower level
        // This uses a very frequent check to catch Windows key usage and immediately refocus
        // Set this up after window is ready
        mainWindow.once('ready-to-show', () => {
            setTimeout(() => {
                const aggressiveFocusInterval = setInterval(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        try {
                            // Continuously ensure window is on top and taskbar is hidden
                            if (process.platform === 'win32') {
                                mainWindow.setSkipTaskbar(true);
                            }
                            
                            // If window loses focus (e.g., Start menu opened), immediately refocus
                            // BUT: Don't refocus if a dialog is showing (allows user to click OK button)
                            if (!mainWindow.isFocused() && !mainWindow._dialogShowing) {
                                const now = Date.now();
                                // Show dialog if focus was lost and enough time has passed since last dialog
                                if ((now - (mainWindow._lastDialogTime || 0)) > 2000) {
                                    mainWindow._dialogShowing = true;
                                    mainWindow._lastDialogTime = now;
                                    
                                    // Show warning dialog via SweetAlert
                                    if (mainWindow && !mainWindow.isDestroyed()) {
                                        mainWindow.webContents.send('show-sweetalert-warning', {
                                            title: 'Unauthorized Action Detected',
                                            text: 'Windows key or unauthorized action detected. You are not allowed to access other applications or the Windows Start menu during the exam. Please remain focused on the exam application.',
                                            icon: 'warning',
                                            confirmButtonText: 'OK',
                                            allowOutsideClick: false,
                                            allowEscapeKey: false
                                        });
                                    }
                                    
                                    // Dialog close will be handled in renderer via IPC
                                    // Set a timeout to reset dialog flag after reasonable time
                                    setTimeout(() => {
                                        mainWindow._dialogShowing = false;
                                    }, 5000); // Reset after 5 seconds if not already reset
                                } else {
                                    // If dialog was shown recently, just refocus without showing another dialog
                                    mainWindow.focus();
                                    if (process.platform === 'win32') {
                                        mainWindow.setAlwaysOnTop(true);
                                        // Force fullscreen to close any overlays
                                        if (!mainWindow.isFullScreen()) {
                                            mainWindow.setFullScreen(true);
                                        }
                                    }
                                }
                            }
                            
                            // Ensure window covers full screen and taskbar is hidden
                            if (process.platform === 'win32') {
                                const primaryDisplay = screen.getPrimaryDisplay();
                                const currentBounds = mainWindow.getBounds();
                                const screenBounds = primaryDisplay.bounds;
                                
                                // Always ensure taskbar is hidden
                                mainWindow.setSkipTaskbar(true);
                                
                                // Ensure fullscreen is maintained
                                if (!mainWindow.isFullScreen()) {
                                    mainWindow.setFullScreen(true);
                                }
                                
                                // Ensure always on top is maintained
                                if (!mainWindow.isAlwaysOnTop()) {
                                    mainWindow.setAlwaysOnTop(true);
                                }
                            }
                        } catch (error) {
                            // Silently handle errors to avoid console spam
                        }
                    } else {
                        clearInterval(aggressiveFocusInterval);
                    }
                }, 50); // Check every 50ms - very aggressive to catch Start menu immediately
                
                // Store interval for cleanup
                mainWindow._aggressiveFocusInterval = aggressiveFocusInterval;
            }, 200); // Start aggressive monitoring after 200ms (reduced from 1500ms for faster response)
        });
        
        // Clean up intervals on window close
        mainWindow.on('closed', () => {
            if (focusInterval) {
                clearInterval(focusInterval);
                focusInterval = null;
            }
            if (mainWindow._aggressiveFocusInterval) {
                clearInterval(mainWindow._aggressiveFocusInterval);
                mainWindow._aggressiveFocusInterval = null;
            }
        });
    }
    mainWindow.webContents.on('before-input-event', (event, input) => {
        // Block Tab key
        if (input.key === 'Tab') {
            event.preventDefault();
            return;
        }

        // Windows-specific: Block Alt+Tab and other escape mechanisms
        if (process.platform === 'win32') {
            // Block Alt+Tab (Alt key + Tab key)
            if (input.key === 'Tab' && input.alt) {
                event.preventDefault();
                return;
            }
            
            // Block Alt+Esc
            if (input.key === 'Escape' && input.alt) {
                event.preventDefault();
                return;
            }
            
            // Block Windows key combinations
            if (input.key === 'Meta' || input.key === 'Super') {
                event.preventDefault();
                return;
            }
            
            // Block Ctrl+Esc (opens Start menu)
            if (input.key === 'Escape' && input.control) {
                event.preventDefault();
                return;
            }
            
            // Block Win+D (show desktop)
            if (input.key === 'd' && input.meta) {
                event.preventDefault();
                return;
            }
            
            // Block Win+R (run dialog)
            if (input.key === 'r' && input.meta) {
                event.preventDefault();
                return;
            }
            
            // Block Win+E (file explorer)
            if (input.key === 'e' && input.meta) {
                event.preventDefault();
                return;
            }
            
            // Block Win+L (lock screen)
            if (input.key === 'l' && input.meta) {
                event.preventDefault();
                return;
            }
            
            // Block Win+M (minimize all)
            if (input.key === 'm' && input.meta) {
                event.preventDefault();
                return;
            }
        }

        // Allow DevTools shortcuts (Ctrl+Shift+I, F12, or Cmd+Opt+I on macOS)
        // Removed blocking to allow toggling DevTools
    });
    
    // Handle failed loads (including iframe errors)
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // Only handle main frame errors, iframe errors are handled in renderer
        if (isMainFrame) {
            console.error('Main frame failed to load:', errorCode, errorDescription, validatedURL);
        }
    });

    // Listen for console errors from renderer (including iframe errors)
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        if (level === 2 && (message.includes('ERR_CONNECTION_REFUSED') || message.includes('Failed to load URL'))) { // level 2 = error
            console.error('Connection error detected:', message);
            mainWindow.webContents.send('lms-connection-error', { message: 'LMS is offline' });
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

        // Show SweetAlert confirmation dialog
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('show-sweetalert-confirm', {
                title: 'Exit ProctorX',
                text: 'Are you sure you want to exit application? This will close the application completely and you will need to restart it to continue.',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Yes, Exit',
                cancelButtonText: 'Cancel',
                allowOutsideClick: false,
                allowEscapeKey: false
            });
            
            // Listen for response
            const handler = (event, confirmed) => {
                ipcMain.removeListener('sweetalert-confirm-response', handler);
                if (confirmed) {
                    app.exit(0);
                }
                // If cancelled, do nothing (window stays open)
            };
            ipcMain.once('sweetalert-confirm-response', handler);
        } else {
            app.exit(0);
        }
    });

}

app.on('open-url', (event, url) => {
    event.preventDefault();
    console.log('Got URL:', url);

    try {
        const parsed = new URL(url);
        const parts = parsed.pathname.split('/').filter(Boolean); // Remove empty strings
        console.log('URL parts:', parts);

        // Expected structure: ['hardcodedId', 'quizId', 'studentId', 'token', 'studentQuizId', 'examType']
        // The 'e-quiz' is part of the hostname, not pathname
        // examType is either 'resit' or 'exam'
        if (parts.length >= 6) {
            const [hardcodedId, quizId, studentId, tkn, studentQuizId, examType] = parts;
            deeplinkData = { quizId, studentId, tkn, sqid: studentQuizId, examType };
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
            console.error('Invalid URL structure. Expected: proctorx://e-quiz/hardcodedId/quizId/studentId/token/sqid/examType');
        }
    } catch (err) {
        console.error('Invalid URL:', err);
    }
});

app.setAsDefaultProtocolClient('proctorx');
app.on('web-contents-created', (_, contents) => {
    // Block Tab key and Windows-specific shortcuts on all windows
    contents.on('before-input-event', (event, input) => {
        if (input.key === 'Tab') {
            event.preventDefault();
        }
        
        // Windows-specific: Block escape mechanisms
        if (process.platform === 'win32') {
            // Block Alt+Tab
            if (input.key === 'Tab' && input.alt) {
                event.preventDefault();
            }
            
            // Block Windows key
            if (input.key === 'Meta' || input.key === 'Super') {
                event.preventDefault();
            }
            
            // Block Ctrl+Esc
            if (input.key === 'Escape' && input.control) {
                event.preventDefault();
            }
        }
    });

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

app.setAsDefaultProtocolClient('proctorx');

app.on('activate', () => {
    // Don't create new windows on activate - let the app stay closed
    // if (BrowserWindow.getAllWindows().length === 0) createWindow();
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

            // Expected structure: ['hardcodedId', 'quizId', 'studentId', 'token', 'studentQuizId', 'examType']
            // The 'e-quiz' is part of the hostname, not pathname
            // examType is either 'resit' or 'exam'
            if (parts.length >= 6) {
                const [hardcodedId, quizId, studentId, tkn, studentQuizId, examType] = parts;
                deeplinkData = { quizId, studentId, tkn, sqid: studentQuizId, examType };
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
                console.error('Invalid URL structure in second instance. Expected: proctorx://e-quiz/hardcodedId/quizId/studentId/token/sqid/examType');
            }
        } catch (err) {
            console.error('Invalid URL in second instance:', err);
        }
    }
});
// Handle getting screen sources
ipcMain.handle('get-sources', async () => {
    return await desktopCapturer.getSources({ types: ['window', 'screen'] })
})

// Handle getting display media stream
ipcMain.handle('get-display-media', async () => {
    try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
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

// Clean up global shortcuts on quit
app.on('will-quit', () => {
    // Unregister all global shortcuts
    globalShortcut.unregisterAll();
});

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

// Monitor display changes
function setupDisplayMonitoring() {
    // Listen for display added/removed events
    screen.on('display-added', (event, newDisplay) => {
        const displays = screen.getAllDisplays();
        console.log(`Display added. Total displays: ${displays.length}`);
        if (displays.length >= 2 && mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'warning',
                buttons: ['OK'],
                defaultId: 0,
                title: 'Multiple Displays Detected',
                message: `Warning: ${displays.length} display(s) detected`,
                detail: 'This application requires a single display setup. Please disconnect additional displays before continuing.'
            }).catch((err) => {
                console.error('Error showing display warning dialog:', err);
            });
        }
    });

    screen.on('display-removed', (event, oldDisplay) => {
        const displays = screen.getAllDisplays();
        console.log(`Display removed. Total displays: ${displays.length}`);
    });

    screen.on('display-metrics-changed', (event, display, changedMetrics) => {
        const displays = screen.getAllDisplays();
        console.log(`Display metrics changed. Total displays: ${displays.length}`);
        if (displays.length >= 2 && mainWindow) {
            // dialog.showMessageBox(mainWindow, {
            //     type: 'warning',
            //     buttons: ['OK'],
            //     defaultId: 0,
            //     title: 'Multiple Displays Detected',
            //     message: `Warning: ${displays.length} display(s) detected`,
            //     detail: 'This application requires a single display setup. Please disconnect additional displays before continuing.'
            // }).catch((err) => {
            //     console.error('Error showing display warning dialog:', err);
            // });
        }
    });
}

app.whenReady().then(() => {
    // Setup display monitoring
    setupDisplayMonitoring();

    // Windows-specific: Register global shortcuts to block Windows key combinations
    // Do this after window creation to avoid blocking startup
    if (process.platform === 'win32') {
        // Helper function to safely register shortcuts
        const registerShortcut = (accelerator, description) => {
            try {
                const ret = globalShortcut.register(accelerator, () => {
                    console.log(`${description} blocked`);
                    // Immediately refocus our window
                     
                    return false;
                });
                if (!ret) {
                    console.warn(`Failed to register shortcut: ${accelerator}`);
                } else {
                    console.log(`Successfully registered shortcut: ${accelerator}`);
                }
            } catch (error) {
                console.error(`Error registering shortcut ${accelerator}:`, error);
            }
        };
        
        // Block Alt+Tab
        registerShortcut('Alt+Tab', 'Alt+Tab');
        
        // Block Alt+Esc
        registerShortcut('Alt+Esc', 'Alt+Esc');
        
        // Block Ctrl+Esc
        registerShortcut('Ctrl+Esc', 'Ctrl+Esc');
        
        // Block Win+D (show desktop)
        registerShortcut('Super+D', 'Win+D');
        
        // Block Win+R (run dialog)
        registerShortcut('Super+R', 'Win+R');
        
        // Block Win+E (file explorer)
        registerShortcut('Super+E', 'Win+E');
        
        // Block Win+L (lock screen)
        registerShortcut('Super+L', 'Win+L');
        
        // Block Win+M (minimize all)
        registerShortcut('Super+M', 'Win+M');
        
        // Block Win+X (power user menu)
        registerShortcut('Super+X', 'Win+X');
        
        // Block Win+Tab (Task View)
        registerShortcut('Super+Tab', 'Win+Tab');
        
        // Block Win+Space (switch input language)
        registerShortcut('Super+Space', 'Win+Space');
        
        // Block Win+Number keys (open taskbar apps)
        for (let i = 1; i <= 9; i++) {
            registerShortcut(`Super+${i}`, `Win+${i}`);
        }
        
        // Additional aggressive blocking will be set up after window is created
        // (moved to createWindow function to avoid accessing mainWindow before it exists)
    }

    // Register global shortcut for exit
    try {
        globalShortcut.register('CommandOrControl+Shift+Q', () => {
            // Show confirmation dialog before quitting
            if (mainWindow) {
                mainWindow.webContents.send('show-sweetalert-confirm', {
                    title: 'Exit ProctorX',
                    text: 'Are you sure you want to exit application? This will close the application completely and you will need to restart it to continue.',
                    icon: 'question',
                    showCancelButton: true,
                    confirmButtonText: 'Yes, Exit',
                    cancelButtonText: 'Cancel',
                    allowOutsideClick: false,
                    allowEscapeKey: false
                });
                
                // Listen for response
                const handler = (event, confirmed) => {
                    ipcMain.removeListener('sweetalert-confirm-response', handler);
                    if (confirmed) {
                        app.exit(0);
                    }
                    // If cancelled, do nothing (window stays open)
                };
                ipcMain.once('sweetalert-confirm-response', handler);
            } else {
                app.exit(0);
            }
        });
    } catch (error) {
        console.error('Error registering exit shortcut:', error);
    }
    createWindow();
})
