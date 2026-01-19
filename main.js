const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, nativeImage, session, screen, TouchBar } = require('electron')
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
let multipleDisplayAlertShowing = false; // Track if multiple display alert is showing

remoteMain.initialize();

// Windows-specific: Request single instance lock to handle deep links when app is already running
if (process.platform === 'win32') {
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
        // Another instance is already running, exit this one
        app.exit(0);
    }
}

// Helper function to parse deep link URL
function parseDeeplinkUrl(url) {
    try {
        console.log('🔍 Parsing deep link URL:', url);
        const parsed = new URL(url);
        console.log('🔍 Parsed URL - hostname:', parsed.hostname, 'pathname:', parsed.pathname);
        const parts = parsed.pathname.split('/').filter(Boolean); // Remove empty strings
        console.log('🔍 URL parts:', parts, 'Length:', parts.length);

        // Expected structure: ['hardcodedId', 'quizId', 'studentId', 'token', 'studentQuizId', 'examType']
        // The 'e-quiz' is part of the hostname, not pathname
        // examType is either 'resit' or 'exam'
        if (parts.length >= 6) {
            const [hardcodedId, quizId, studentId, tkn, studentQuizId, examType] = parts;
            const data = { quizId, studentId, tkn, sqid: studentQuizId, examType };
            console.log('✅ Successfully parsed deep link data:', data);
            return data;
        } else {
            console.error('❌ Invalid URL structure. Expected: proctorx://e-quiz/hardcodedId/quizId/studentId/token/sqid/examType');
            console.error('❌ Got', parts.length, 'parts, expected at least 6');
            return null;
        }
    } catch (err) {
        console.error('❌ Error parsing URL:', err);
        return null;
    }
}

// Helper function to send launch data to renderer
function sendLaunchDataToRenderer(data) {
    if (!data) return;
    
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
                // Add a delay to ensure renderer DOMContentLoaded and handlers are ready
                setTimeout(() => {
                    console.log('Sending launch-data IPC message...');
                    mainWindow.webContents.send('launch-data', data);
                    console.log('Launch data sent successfully');
                }, 1000); // Increased delay to ensure renderer is fully ready
            });
        } else {
            console.log('Window already loaded, sending launch data...');
            // Add a delay to ensure renderer DOMContentLoaded and handlers are ready
            setTimeout(() => {
                console.log('Sending launch-data IPC message...');
                mainWindow.webContents.send('launch-data', data);
                console.log('Launch data sent successfully');
            }, 1000); // Increased delay to ensure renderer is fully ready
        }
    } else {
        console.error('Main window not found, storing deeplink data for later');
        // Store data to send when window is created
        deeplinkData = data;
    }
}

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
        kiosk: false, // True kiosk mode (even more restrictive than fullscreen)
        alwaysOnTop: false, // Keep window on top of others
        movable: true, // Prevent window movement
        minimizable: true, // Disable minimize button
        maximizable: true, // Disable maximize button
        closable: true, // Enable close button
        // titleBarStyle: 'hidden', // Alternative to frame: false on macOS
        // autoHideMenuBar: true,// Alternative for menu visibility
        width: 1000, // Default width (will be overridden by fullscreen)
        height: 800, // Default height (will be overridden by fullscreen)
        // fullscreen: true, // Enable fullscreen mode
        // resizable: false, // Disable window resizing
        // frame: false, // Remove window frame (including close/minimize buttons)
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
    // if (!app.isPackaged) {
        mainWindow.webContents.openDevTools()
    // }
    // mainWindow.setMenu(null) // Remove menu bar

    // Disable Touch Bar on macOS by creating an empty TouchBar
    // This overrides system-level Touch Bar items like "now playing"
    if (process.platform === 'darwin') {
        try {
            // Create an empty TouchBar with no items to completely disable it
            const emptyTouchBar = new TouchBar({ items: [] });
            mainWindow.setTouchBar(emptyTouchBar);
        } catch (error) {
            console.error('Error setting Touch Bar:', error);
            // Fallback to null if TouchBar creation fails
            mainWindow.setTouchBar(null);
        }
    }

    // Windows-specific: Hide from taskbar and set additional properties
    if (process.platform === 'win32') {
        // Hide window from taskbar immediately
        mainWindow.setSkipTaskbar(false);
    }

    // Ensure window is shown (important for kiosk mode on Windows)
    mainWindow.once('ready-to-show', () => {
        // Check for multiple displays immediately when window is ready
        const displays = screen.getAllDisplays();
        console.log(`Detected ${displays.length} display(s) on ready-to-show`);
        if (displays.length >= 2 && !multipleDisplayAlertShowing) {
            // Wait a bit for renderer to be ready, then show alert
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed() && !multipleDisplayAlertShowing) {
                    console.log('Sending show-sweetalert-multiple-display IPC message from ready-to-show');
                    // Don't set flag yet - wait for confirmation from renderer
                    mainWindow.webContents.send('show-sweetalert-multiple-display', {
                        title: 'Multiple Displays Detected',
                        text: `Warning: ${displays.length} display(s) detected. This application requires a single display setup. Please disconnect additional displays before continuing.`,
                        icon: 'warning',
                        showConfirmButton: false,
                        allowOutsideClick: false,
                        allowEscapeKey: false,
                        allowEnterKey: false,
                        showCloseButton: false
                    });
                }
            }, 2000); // Wait 2 seconds for renderer to fully initialize
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            // Windows-specific: Ensure fullscreen and hide taskbar BEFORE showing
            if (process.platform === 'win32') {
                // Set fullscreen and hide taskbar before showing window
                mainWindow.setSkipTaskbar(false);
                //mainWindow.setFullScreen(false);
                //mainWindow.setAlwaysOnTop(true);
            }

            mainWindow.show();
            mainWindow.focus();

            // Additional Windows-specific setup after window is shown
            // Use multiple attempts to ensure taskbar is hidden and window is on top
            if (process.platform === 'win32') {
                // Immediate setup - right after show()
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.setSkipTaskbar(false);
                    //mainWindow.setFullScreen(false);
                    //mainWindow.setAlwaysOnTop(true);
                    mainWindow.focus();
                }

                // First attempt after a brief delay
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(false);
                        //mainWindow.setFullScreen(false);
                        //mainWindow.setAlwaysOnTop(true);
                        mainWindow.focus();
                    }
                }, 50);

                // Second attempt to ensure it sticks
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(false);
                        //mainWindow.setFullScreen(false);
                        //mainWindow.setAlwaysOnTop(true);
                        mainWindow.focus();
                    }
                }, 200);

                // Third attempt for stubborn cases
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(false);
                        //mainWindow.setFullScreen(false);
                        //mainWindow.setAlwaysOnTop(true);
                        mainWindow.focus();
                    }
                }, 500);

                // Fourth attempt for very stubborn cases
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(false);
                        //mainWindow.setFullScreen(false);
                        //mainWindow.setAlwaysOnTop(true);
                        mainWindow.focus();
                    }
                }, 1000);
            }
        }
    });

    mainWindow.loadFile('index.html')


    mainWindow.webContents.on('did-finish-load', () => {
        console.log('Window finished loading, checking for deeplink data...');

        // Check for multiple displays - wait a bit for renderer to be ready
        setTimeout(() => {
            const displays = screen.getAllDisplays();
            console.log(`Detected ${displays.length} display(s) on did-finish-load`);
            if (displays.length >= 2) {
                // Show non-dismissable SweetAlert warning via IPC
                if (mainWindow && !mainWindow.isDestroyed() && !multipleDisplayAlertShowing) {
                    console.log('Sending show-sweetalert-multiple-display IPC message from did-finish-load');
                    // Don't set flag yet - wait for confirmation from renderer
                    mainWindow.webContents.send('show-sweetalert-multiple-display', {
                        title: 'Multiple Displays Detected',
                        text: `Warning: ${displays.length} display(s) detected. This application requires a single display setup. Please disconnect additional displays before continuing.`,
                        icon: 'warning',
                        showConfirmButton: false,
                        allowOutsideClick: false,
                        allowEscapeKey: false,
                        allowEnterKey: false,
                        showCloseButton: false
                    });
                } else if (multipleDisplayAlertShowing) {
                    console.log('Multiple display alert already showing, skipping');
                }
            } else if (displays.length === 1 && multipleDisplayAlertShowing) {
                // Auto-dismiss alert when display count becomes 1
                if (mainWindow && !mainWindow.isDestroyed()) {
                    multipleDisplayAlertShowing = false;
                    console.log('Sending close-multiple-display-alert IPC message');
                    mainWindow.webContents.send('close-multiple-display-alert');
                }
            }
        }, 1500); // Wait 1.5 seconds for renderer to be ready

        if (deeplinkData) {
            console.log('Found deeplink data, sending to renderer...');
            // Add a delay to ensure renderer DOMContentLoaded and handlers are ready
            setTimeout(() => {
                console.log('Sending launch-data IPC message from did-finish-load...');
                mainWindow.webContents.send('launch-data', deeplinkData);
                console.log('Launch data sent from did-finish-load handler');
            }, 1000); // Increased delay to ensure renderer is fully ready
        } else {
            console.log('No deeplink data available yet');
        }
    });
    // Optional: Make sure window stays fullscreen even if user tries to exit
    mainWindow.on('leave-full-screen', () => {
        //mainWindow.setFullScreen(false)
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
                    mainWindow.setSkipTaskbar(false);
                    //mainWindow.setFullScreen(false);
                    //mainWindow.setAlwaysOnTop(true);
                    mainWindow.focus();
                }
            }

            setTimeout(() => {
                focusInterval = setInterval(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        try {
                            // Hide from taskbar continuously
                            mainWindow.setSkipTaskbar(false);

                            if (!mainWindow.isFocused()) {
                                mainWindow.focus();
                            }
                            if (!mainWindow.isAlwaysOnTop()) {
                                //mainWindow.setAlwaysOnTop(true);
                            }
                            if (!mainWindow.isFullScreen()) {
                                //mainWindow.setFullScreen(false);
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
                                mainWindow.setSkipTaskbar(false);
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
                                        //mainWindow.setAlwaysOnTop(true);
                                        // Force fullscreen to close any overlays
                                        if (!mainWindow.isFullScreen()) {
                                            //mainWindow.setFullScreen(false);
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
                                mainWindow.setSkipTaskbar(false);

                                // Ensure fullscreen is maintained
                                if (!mainWindow.isFullScreen()) {
                                    //mainWindow.setFullScreen(false);
                                }

                                // Ensure always on top is maintained
                                if (!mainWindow.isAlwaysOnTop()) {
                                    //mainWindow.setAlwaysOnTop(true);
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

// macOS-specific: Handle open-url event
app.on('open-url', (event, url) => {
    event.preventDefault();
    console.log('Got URL (macOS):', url);
    const data = parseDeeplinkUrl(url);
    if (data) {
        deeplinkData = data;
        console.log('Parsed deeplink data:', deeplinkData);
        sendLaunchDataToRenderer(deeplinkData);
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

// Handle second-instance (for Windows - when app is already running)
app.on('second-instance', (event, argv) => {
    const url = argv.find((arg) => arg.startsWith('proctorx://'));
    if (url) {
        console.log('Second instance URL (Windows):', url);
        const data = parseDeeplinkUrl(url);
        if (data) {
            deeplinkData = data;
            console.log('Second instance parsed deeplink data:', deeplinkData);
            sendLaunchDataToRenderer(deeplinkData);
        }
    }
});
// Handle getting app version
ipcMain.handle('get-app-version', async () => {
    return app.getVersion();
})

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

// Battery and Network Status Handlers
ipcMain.handle('get-battery-status', async () => {
    try {
        // Use systemPreferences for battery info (Windows/Linux)
        if (process.platform === 'win32' || process.platform === 'linux') {
            // For Windows/Linux, we'll use a fallback approach
            // The renderer will use navigator.getBattery() API
            return { level: null, charging: null, available: false };
        } else if (process.platform === 'darwin') {
            // macOS can use systemPreferences
            const systemPreferences = require('electron').systemPreferences;
            // Note: systemPreferences doesn't have direct battery API
            // We'll rely on the browser API in renderer
            return { level: null, charging: null, available: false };
        }
    } catch (error) {
        console.error('Error getting battery status:', error);
        return { level: null, charging: null, available: false };
    }
});

ipcMain.handle('get-network-status', async () => {
    // Network status is better handled in the renderer using navigator.onLine
    // This handler is kept for compatibility but renderer will use browser API
    return { online: true };
});

// Handler for multiple display alert confirmation
ipcMain.on('multiple-display-alert-shown', () => {
    console.log('Multiple display alert confirmed as shown');
    multipleDisplayAlertShowing = true;
});

ipcMain.on('multiple-display-alert-closed', () => {
    console.log('Multiple display alert confirmed as closed');
    multipleDisplayAlertShowing = false;
});

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
        // Send message to renderer to log exit audit before quitting
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('send-exit-audit-log');
            // Give a small delay for audit log to be sent
            setTimeout(() => {
                app.quit();
            }, 500);
        } else {
            app.quit();
        }
    } catch (error) {
        console.error('Failed to quit:', error)
        app.quit();
    }

})

// Monitor display changes
function setupDisplayMonitoring() {
    // Listen for display added/removed events
    screen.on('display-added', (event, newDisplay) => {
        // Check if mainWindow still exists before using it
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        const displays = screen.getAllDisplays();
        console.log(`Display added. Total displays: ${displays.length}`);
        if (displays.length >= 2 && !multipleDisplayAlertShowing) {
            // Show non-dismissable SweetAlert warning
            // Don't set flag yet - wait for confirmation from renderer
            mainWindow.webContents.send('show-sweetalert-multiple-display', {
                title: 'Multiple Displays Detected',
                text: `Warning: ${displays.length} display(s) detected. This application requires a single display setup. Please disconnect additional displays before continuing.`,
                icon: 'warning',
                showConfirmButton: false,
                allowOutsideClick: false,
                allowEscapeKey: false,
                allowEnterKey: false,
                showCloseButton: false
            });
        }
    });

    screen.on('display-removed', (event, oldDisplay) => {
        // Check if mainWindow still exists before using it
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        const displays = screen.getAllDisplays();
        console.log(`Display removed. Total displays: ${displays.length}`);

        // Auto-dismiss alert when display count becomes 1
        if (displays.length === 1 && multipleDisplayAlertShowing) {
            // Flag will be reset when renderer confirms closure
            mainWindow.webContents.send('close-multiple-display-alert');
        }
    });

    screen.on('display-metrics-changed', (event, display, changedMetrics) => {
        // Check if mainWindow still exists before using it
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        const displays = screen.getAllDisplays();
        console.log(`Display metrics changed. Total displays: ${displays.length}`);

        // Check if we need to show or hide the alert
        if (displays.length >= 2 && !multipleDisplayAlertShowing) {
            // Show non-dismissable SweetAlert warning
            // Don't set flag yet - wait for confirmation from renderer
            mainWindow.webContents.send('show-sweetalert-multiple-display', {
                title: 'Multiple Displays Detected',
                text: `Warning: ${displays.length} display(s) detected. This application requires a single display setup. Please disconnect additional displays before continuing.`,
                icon: 'warning',
                showConfirmButton: false,
                allowOutsideClick: false,
                allowEscapeKey: false,
                allowEnterKey: false,
                showCloseButton: false
            });
        } else if (displays.length === 1 && multipleDisplayAlertShowing) {
            // Auto-dismiss alert when display count becomes 1
            // Flag will be reset when renderer confirms closure
            mainWindow.webContents.send('close-multiple-display-alert');
        }
    });
}

app.whenReady().then(() => {
    // Check for deep link URL in command line arguments (Windows initial launch)
    console.log('🔍 Checking process.argv for deep link URL...');
    console.log('🔍 process.argv:', process.argv);
    console.log('🔍 process.platform:', process.platform);
    
    if (process.platform === 'win32') {
        const url = process.argv.find((arg) => arg.startsWith('proctorx://'));
        if (url) {
            console.log('✅ Found deep link URL in command line (Windows initial launch):', url);
            const data = parseDeeplinkUrl(url);
            if (data) {
                deeplinkData = data;
                console.log('✅ Parsed deeplink data from command line:', deeplinkData);
            } else {
                console.error('❌ Failed to parse deeplink data from command line');
            }
        } else {
            console.log('ℹ️ No deep link URL found in process.argv');
        }
    } else {
        // Also check for macOS/Linux
        const url = process.argv.find((arg) => arg.startsWith('proctorx://'));
        if (url) {
            console.log('✅ Found deep link URL in command line:', url);
            const data = parseDeeplinkUrl(url);
            if (data) {
                deeplinkData = data;
                console.log('✅ Parsed deeplink data from command line:', deeplinkData);
            }
        }
    }
    
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
            // Don't allow exit if multiple displays are detected
            const displays = screen.getAllDisplays();
            if (displays.length >= 2 && multipleDisplayAlertShowing) {
                console.log('Exit blocked: Multiple displays detected');
                return;
            }

            // Show confirmation dialog before quitting
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
                        // Send message to renderer to log exit audit before quitting
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('send-exit-audit-log');
                            // Give a small delay for audit log to be sent
                            setTimeout(() => {
                                app.exit(0);
                            }, 500);
                        } else {
                            app.exit(0);
                        }
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
