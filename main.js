const {
    app,
    BrowserWindow,
    ipcMain,
    desktopCapturer,
    dialog,
    nativeImage,
    session,
    screen,
    TouchBar,
    systemPreferences,
    shell
} = require('electron')
const path = require('path')
const remoteMain = require('@electron/remote/main');
const { globalShortcut } = require('electron');

// Must be set before app.whenReady() so Windows maps the running process to our
// app identity (matching the NSIS shortcut's AppUserModelID) — without this,
// Windows shows the default Electron icon in the taskbar and Start menu.
if (process.platform === 'win32') {
    app.setAppUserModelId('com.cps.proctorx');
}

// Enable screen capture in Electron
app.commandLine.appendSwitch('enable-usermedia-screen-capturing')
app.commandLine.appendSwitch('allow-http-screen-capture')
app.commandLine.appendSwitch('disable-site-isolation-trials')

let mainWindow
/** Linux-only: screen capture is tied to this BrowserWindow; never use a helper window PipeWire closes. */
let linuxExamKioskApplied = false;

let deeplinkData = null;
let multipleDisplayAlertShowing = false; // Track if multiple display alert is showing
let isExamMode = false; // Track if user is on an exam page (disables exit shortcut)
const examFrameIds = new Set(); // routing IDs of frames currently on an exam URL

function shouldEnforceLinuxKioskGuards() {
    return process.platform !== 'linux' || linuxExamKioskApplied;
}

const EXAM_URL_PATTERNS = [
    /56565f34-9e79-4f6e-972e-0aefbfcc111e/,
    /\/(e-upload|r-upload)\//,
];

function checkIsExamUrl(url) {
    return url ? EXAM_URL_PATTERNS.some((re) => re.test(url)) : false;
}

function updateExamFrame(frameRoutingId, url) {
    if (checkIsExamUrl(url)) {
        examFrameIds.add(frameRoutingId);
    } else {
        examFrameIds.delete(frameRoutingId);
    }
    const nowExam = examFrameIds.size > 0;
    if (nowExam !== isExamMode) {
        isExamMode = nowExam;
        console.log(`Exam mode: ${isExamMode} (URL: ${url})`);
    }
}

remoteMain.initialize();

// Enforce single instance on Windows and Linux
if (process.platform === 'win32' || process.platform === 'linux') {
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
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

        // Expected structure: ['hardcodedId', 'quizId', 'studentId', 'token', 'studentQuizId', 'examType', 'pdf_mcq']
        // The 'e-quiz' is part of the hostname, not pathname
        // examType is either 'resit' or 'exam'
        // pdf_mcq is either 'pdf' or 'mcq' (optional, defaults to 'pdf')
        if (parts.length >= 6) {
            const [hardcodedId, quizId, studentId, tkn, studentQuizId, examType, pdf_mcq] = parts;
            const data = { quizId, studentId, tkn, sqid: studentQuizId, examType, pdf_mcq: pdf_mcq || 'pdf' };
            console.log('✅ Successfully parsed deep link data:', data);
            return data;
        } else {
            console.error('❌ Invalid URL structure. Expected: proctorx://e-quiz/hardcodedId/quizId/studentId/token/sqid/examType/pdf_mcq');
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
    const primaryBounds = screen.getPrimaryDisplay().bounds;
    const isKioskPlatform = process.platform === 'darwin' || process.platform === 'win32';
    mainWindow = new BrowserWindow({
        x: primaryBounds.x,
        y: primaryBounds.y,
        width: primaryBounds.width,
        height: primaryBounds.height,
        kiosk: isKioskPlatform,
        alwaysOnTop: false, // Keep window on top of others
        movable: !isKioskPlatform,
        minimizable: !isKioskPlatform,
        maximizable: !isKioskPlatform,
        closable: true, // Close button still shows but is intercepted below
        titleBarStyle: 'hidden',
        autoHideMenuBar: true,
        fullscreen: isKioskPlatform,
        resizable: !isKioskPlatform,
        frame: process.platform === 'linux', // Remove window frame on mac/win
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

    // Windows: keep in taskbar and force our icon (belt-and-suspenders over BrowserWindow icon option)
    if (process.platform === 'win32') {
        mainWindow.setSkipTaskbar(false);
        const winIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
        if (!winIcon.isEmpty()) {
            mainWindow.setIcon(winIcon);
        }
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
                mainWindow.setSkipTaskbar(false);
                mainWindow.setFullScreen(true);
                mainWindow.setAlwaysOnTop(true, 'screen-saver');
            }

            mainWindow.show();
            mainWindow.focus();

            // Additional Windows-specific setup after window is shown — multiple
            // attempts because Windows compositor can reset these on first paint.
            if (process.platform === 'win32') {
                const enforceWin = () => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(false);
                        mainWindow.setFullScreen(true);
                        mainWindow.setAlwaysOnTop(true, 'screen-saver');
                        mainWindow.focus();
                    }
                };
                enforceWin();
                setTimeout(enforceWin, 50);
                setTimeout(enforceWin, 200);
                setTimeout(enforceWin, 500);
                setTimeout(enforceWin, 1000);
            }

            if (process.platform === 'darwin') {
                const enforceMac = () => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setAlwaysOnTop(true, 'screen-saver');
                        mainWindow.focus();
                    }
                };
                enforceMac();
                setTimeout(enforceMac, 50);
                setTimeout(enforceMac, 200);
                setTimeout(enforceMac, 500);
                setTimeout(enforceMac, 1000);
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
    // Track exam URLs across main frame and all iframes
    // did-navigate: full navigation (url, httpCode, httpText, isMainFrame, frameProcessId, frameRoutingId)
    mainWindow.webContents.on('did-navigate', (_ev, url, _code, _text, _isMain, _pid, frameRoutingId) => {
        updateExamFrame(frameRoutingId, url);
    });
    // did-navigate-in-page: React Router / hash changes (url, isMainFrame, frameProcessId, frameRoutingId)
    mainWindow.webContents.on('did-navigate-in-page', (_ev, url, _isMain, _pid, frameRoutingId) => {
        updateExamFrame(frameRoutingId, url);
    });
    // did-frame-navigate: any frame incl. iframes (url, httpCode, httpText, isMainFrame, frameProcessId, frameRoutingId)
    mainWindow.webContents.on('did-frame-navigate', (_ev, url, _code, _text, _isMain, _pid, frameRoutingId) => {
        updateExamFrame(frameRoutingId, url);
    });

    // Re-enter fullscreen/kiosk if the user somehow exits (mac/win only)
    mainWindow.on('leave-full-screen', () => {
        if (process.platform === 'darwin' || process.platform === 'win32') {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.setFullScreen(true);
            }
        }
    });
    // macOS: warn + refocus when the app loses focus; re-assert screen-saver level to stay above Teams/Zoom PiP
    if (process.platform === 'darwin') {
        mainWindow._dialogShowing = false;
        mainWindow.on('blur', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.setAlwaysOnTop(true, 'screen-saver');
            }
            const now = Date.now();
            if (!mainWindow._dialogShowing && (now - (mainWindow._lastDialogTime || 0)) > 2000) {
                mainWindow._dialogShowing = true;
                mainWindow._lastDialogTime = now;
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('show-sweetalert-warning', {
                        title: 'Unauthorized Action Detected',
                        text: 'You are not allowed to switch applications during the exam. Please remain focused on the exam application.',
                        icon: 'warning',
                        confirmButtonText: 'OK',
                        allowOutsideClick: false,
                        allowEscapeKey: false
                    });
                }
                setTimeout(() => {
                    mainWindow._dialogShowing = false;
                }, 5000);
            }
            // Refocus after a short delay (allows the warning dialog to render)
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed() && !mainWindow._dialogShowing) {
                    mainWindow.focus();
                }
            }, 300);
        });

        const macFocusInterval = setInterval(() => {
            if (!mainWindow || mainWindow.isDestroyed()) {
                clearInterval(macFocusInterval);
                return;
            }
            if (!mainWindow.isAlwaysOnTop()) {
                mainWindow.setAlwaysOnTop(true, 'screen-saver');
            }
        }, 500);
        mainWindow.on('closed', () => clearInterval(macFocusInterval));
    }

    // Keep window focused and on top (Windows + Linux)
    if (process.platform === 'win32' || process.platform === 'linux') {
        let focusInterval = null;
        // Store dialogShowing flag on mainWindow so it's accessible from all scopes
        mainWindow._dialogShowing = false;
        let lastBlurTime = 0; // Track when blur occurred

        // Wait for window to be ready before setting up focus management
        mainWindow.once('ready-to-show', () => {
            // Monitor window focus and keep it on top
            mainWindow.on('blur', () => {
                if (!shouldEnforceLinuxKioskGuards()) {
                    return;
                }
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
                if (!shouldEnforceLinuxKioskGuards()) {
                    return;
                }
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

            // Keep window always on top — immediate enforcement for Windows
            if (process.platform === 'win32') {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.setSkipTaskbar(false);
                    mainWindow.setFullScreen(true);
                    mainWindow.setAlwaysOnTop(true, 'screen-saver');
                    mainWindow.focus();
                }
            }

            setTimeout(() => {
                focusInterval = setInterval(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        try {
                            if (!shouldEnforceLinuxKioskGuards()) {
                                return;
                            }
                            if (process.platform === 'win32') {
                                mainWindow.setSkipTaskbar(false);
                                if (!mainWindow.isAlwaysOnTop()) {
                                    mainWindow.setAlwaysOnTop(true, 'screen-saver');
                                }
                                if (!mainWindow.isFullScreen()) {
                                    mainWindow.setFullScreen(true);
                                }
                            }
                            if (!mainWindow.isFocused()) {
                                mainWindow.focus();
                            }
                        } catch (error) {
                            console.error('Error maintaining window state:', error);
                        }
                    } else {
                        if (focusInterval) {
                            clearInterval(focusInterval);
                            focusInterval = null;
                        }
                    }
                }, 500);
            }, 100);
        });

        // Additional aggressive blocking: Monitor for Windows key presses at lower level
        // This uses a very frequent check to catch Windows key usage and immediately refocus
        // Set this up after window is ready
        mainWindow.once('ready-to-show', () => {
            setTimeout(() => {
                const aggressiveFocusInterval = setInterval(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        try {
                            if (!shouldEnforceLinuxKioskGuards()) {
                                return;
                            }
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
                                        mainWindow.setAlwaysOnTop(true, 'screen-saver');
                                        if (!mainWindow.isFullScreen()) {
                                            mainWindow.setFullScreen(true);
                                        }
                                    }
                                }
                            }

                            // Ensure window covers full screen and taskbar is hidden
                            if (process.platform === 'win32') {
                                mainWindow.setSkipTaskbar(false);
                                if (!mainWindow.isFullScreen()) {
                                    mainWindow.setFullScreen(true);
                                }
                                if (!mainWindow.isAlwaysOnTop()) {
                                    mainWindow.setAlwaysOnTop(true, 'screen-saver');
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
        if (!shouldEnforceLinuxKioskGuards()) {
            return;
        }
        // Block Tab key
        if (input.key === 'Tab') {
            event.preventDefault();
            return;
        }

        // Windows + Linux: Block Alt+Tab and other escape mechanisms
        if (process.platform === 'win32' || process.platform === 'linux') {
            // Block Alt+Tab
            if (input.key === 'Tab' && input.alt) {
                event.preventDefault();
                return;
            }

            // Block Alt+Esc
            if (input.key === 'Escape' && input.alt) {
                event.preventDefault();
                return;
            }

            // Block Super/Meta key (Windows key / Super key)
            if (input.key === 'Meta' || input.key === 'Super') {
                event.preventDefault();
                return;
            }

            // Block Ctrl+Esc (opens Start/Activities menu)
            if (input.key === 'Escape' && input.control) {
                event.preventDefault();
                return;
            }

            // Block Super+D (show desktop)
            if (input.key === 'd' && input.meta) {
                event.preventDefault();
                return;
            }

            // Block Super+R (run dialog / GNOME runner)
            if (input.key === 'r' && input.meta) {
                event.preventDefault();
                return;
            }

            // Block Super+E (file manager)
            if (input.key === 'e' && input.meta) {
                event.preventDefault();
                return;
            }

            // Block Super+L (lock screen)
            if (input.key === 'l' && input.meta) {
                event.preventDefault();
                return;
            }

            // Block Super+M (minimize all / notifications)
            if (input.key === 'm' && input.meta) {
                event.preventDefault();
                return;
            }

            // Block Super+Tab (GNOME window switcher)
            if (input.key === 'Tab' && input.meta) {
                event.preventDefault();
                return;
            }
        }

        // macOS: block common escape shortcuts
        if (process.platform === 'darwin') {
            // Cmd+H (hide), Cmd+M (minimize), Cmd+Tab (app switch), Cmd+` (window switch)
            if (input.meta && (input.key === 'h' || input.key === 'm' || input.key === 'Tab' || input.key === '`')) {
                event.preventDefault();
                return;
            }
            // Cmd+Space (Spotlight), Cmd+Opt+Esc (Force Quit)
            if (input.meta && input.key === ' ') {
                event.preventDefault();
                return;
            }
            if (input.meta && input.alt && input.key === 'Escape') {
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

    // On Linux (kiosk mode), OS-level screen-share picker can appear behind the app.
    // Register on Session to auto-select primary screen and bypass the picker.
    mainWindow.webContents.session.setDisplayMediaRequestHandler(
        async (request, callback) => {
            try {
                const sources = await desktopCapturer.getSources({types: ['screen']});
                callback({video: sources[0], audio: 'loopback'});
            } catch {
                callback({});
            }
        },
        {useSystemPicker: false}
    );

    // Block close button — only Cmd/Ctrl+Shift+Q is allowed to exit
    mainWindow.on('close', (event) => {
        event.preventDefault();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('show-sweetalert-dialog', {
                title: 'Close Button Disabled',
                text: process.platform === 'darwin'
                    ? 'Use Cmd+Shift+Q to exit the application.'
                    : 'Use Ctrl+Shift+Q to exit the application.',
                icon: 'info',
                confirmButtonText: 'OK',
                allowOutsideClick: false,
                allowEscapeKey: false
            });
        }
    });

}

/** Elevate this same window to kiosk/fullscreen after permission checks pass.
 * On Linux, aggressive focus/minimize guards (see ready-to-show handlers) steal focus from
 * xdg-desktop-portal while the renderer starts a second capture after the permission overlay.
 * @param {{ skipLinuxKioskGuards?: boolean }} [opts]
 */
function applyExamKioskModeInternal(opts = {}) {
    const skipLinuxGuards = process.platform === 'linux' && !!opts.skipLinuxKioskGuards;
    if (!mainWindow || mainWindow.isDestroyed()) {
        return {ok: false, reason: 'no-window'};
    }
    if (linuxExamKioskApplied) {
        return {ok: true, already: true};
    }
    let activatedLinuxGuards = false;
    if (!skipLinuxGuards) {
        linuxExamKioskApplied = true;
        activatedLinuxGuards = true;
    }
    try {
        const primaryDisplay = screen.getPrimaryDisplay();
        const targetBounds = primaryDisplay?.bounds;
        const safeSet = (fnName, ...args) => {
            try {
                if (typeof mainWindow[fnName] === 'function') {
                    mainWindow[fnName](...args);
                }
            } catch (err) {
                console.warn(`Window method failed: ${fnName}`, err?.message || err);
            }
        };
        if (typeof mainWindow.setMenuBarVisibility === 'function') {
            safeSet('setMenuBarVisibility', false);
        }
        // Apply fullscreen/kiosk stack dynamically — Linux only.
        // macOS and Windows have their own window behaviour and were working before;
        // applying kiosk here would break their window chrome.
        if (process.platform === 'linux') {
            if (targetBounds) {
                safeSet('setBounds', targetBounds);
            }
            safeSet('setFullScreen', true);
            safeSet('setKiosk', true);
            safeSet('setMovable', false);
            safeSet('setMinimizable', false);
            safeSet('setResizable', false);
            safeSet('focus');
        }
        return {
            ok: true,
            state: {
                kiosk: mainWindow.isKiosk(),
                fullScreen: mainWindow.isFullScreen(),
                alwaysOnTop: mainWindow.isAlwaysOnTop(),
            },
        };
    } catch (e) {
        console.error('Exam kiosk elevation failed:', e);
        if (activatedLinuxGuards) {
            linuxExamKioskApplied = false;
        }
        return {ok: false, reason: String(e.message || e)};
    }
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
        if (!shouldEnforceLinuxKioskGuards()) {
            return;
        }
        if (input.key === 'Tab') {
            event.preventDefault();
        }

        // Windows + Linux: Block escape mechanisms
        if (process.platform === 'win32' || process.platform === 'linux') {
            // Block Alt+Tab
            if (input.key === 'Tab' && input.alt) {
                event.preventDefault();
            }

            // Block Super/Meta key
            if (input.key === 'Meta' || input.key === 'Super') {
                event.preventDefault();
            }

            // Block Super+Tab (GNOME window switcher)
            if (input.key === 'Tab' && input.meta) {
                event.preventDefault();
            }

            // Block Ctrl+Esc
            if (input.key === 'Escape' && input.control) {
                event.preventDefault();
            }
        }

        // macOS: block common escape shortcuts
        if (process.platform === 'darwin') {
            if (input.meta && (input.key === 'h' || input.key === 'm' || input.key === 'Tab' || input.key === '`')) {
                event.preventDefault();
            }
            if (input.meta && input.key === ' ') {
                event.preventDefault();
            }
            if (input.meta && input.alt && input.key === 'Escape') {
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
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
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
    return await desktopCapturer.getSources({types: ['screen']})
})

ipcMain.handle('get-screen-access-status', async () => {
    if (process.platform !== 'darwin') {
        return 'granted';
    }
    try {
        return systemPreferences.getMediaAccessStatus('screen');
    } catch (error) {
        console.error('Error checking screen recording permission:', error);
        return 'unknown';
    }
})

// Returns {camera, microphone, screen} permission statuses.
// On non-macOS platforms all return 'granted'.
ipcMain.handle('get-media-access-status', async () => {
    if (process.platform !== 'darwin') {
        return {camera: 'granted', microphone: 'granted', screen: 'granted'};
    }
    return {
        camera: systemPreferences.getMediaAccessStatus('camera'),
        microphone: systemPreferences.getMediaAccessStatus('microphone'),
        screen: systemPreferences.getMediaAccessStatus('screen'),
    };
})

// Trigger the screen recording TCC prompt by attempting getSources.
// Returns true if at least one source was returned (permission granted).
ipcMain.handle('request-screen-permission', async () => {
    try {
        const sources = await desktopCapturer.getSources({types: ['screen']});
        return sources.length > 0;
    } catch {
        return false;
    }
})

ipcMain.handle('apply-exam-kiosk-mode', async () =>
    applyExamKioskModeInternal({skipLinuxKioskGuards: process.platform === 'linux'})
);
ipcMain.handle('linux-apply-exam-kiosk-mode', async () =>
    applyExamKioskModeInternal({skipLinuxKioskGuards: false})
);

// Linux: temporarily exit kiosk so a re-share portal dialog is not hidden behind the fullscreen window
ipcMain.handle('linux-exit-exam-kiosk-mode', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return {ok: false};
    try {
        linuxExamKioskApplied = false;
        mainWindow.setKiosk(false);
        mainWindow.setFullScreen(false);
        mainWindow.setMovable(true);
        mainWindow.setMinimizable(true);
        mainWindow.setResizable(true);
        return {ok: true};
    } catch (e) {
        return {ok: false, reason: String(e)};
    }
});

ipcMain.handle('open-screen-capture-settings', async () => {
    if (process.platform !== 'darwin') {
        return false;
    }
    try {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        return true;
    } catch (error) {
        console.error('Error opening screen recording settings:', error);
        return false;
    }
})

ipcMain.handle('open-privacy-settings', async (_, type) => {
    const urls = {
        camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
        microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    };
    const url = urls[type] || 'x-apple.systempreferences:com.apple.preference.security?Privacy';
    try {
        await shell.openExternal(url);
        return true;
    } catch {
        return false;
    }
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

// Set/clear exam mode from renderer — disables Cmd/Ctrl+Shift+Q while active
ipcMain.on('set-exam-mode', (_, active) => {
    isExamMode = !!active;
    console.log(`Exam mode: ${isExamMode}`);
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

// Force quit — bypasses the window close event (used from permission overlay)
ipcMain.on('force-quit-app', () => {
    console.log('Force quit command received');
    app.exit(0);
});

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

    // Register global shortcuts to block key combinations.
    // Linux intentionally avoids these until sharing is enabled.
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

    // Block Cmd+Q on macOS so it cannot be used to quit
    if (process.platform === 'darwin') {
        const macShortcuts = [
            ['Command+Q', 'Cmd+Q'],
            ['Command+H', 'Cmd+H (hide)'],
            ['Command+M', 'Cmd+M (minimize)'],
            ['Command+Tab', 'Cmd+Tab (app switcher)'],
            ['Command+`', 'Cmd+` (window switcher)'],
            ['Command+Space', 'Cmd+Space (Spotlight)'],
            ['Command+Option+Escape', 'Cmd+Opt+Esc (Force Quit)'],
            ['Control+Up', 'Mission Control'],
            ['Control+Down', 'App Expose'],
            ['Control+Left', 'Space left'],
            ['Control+Right', 'Space right'],
        ];
        for (const [accelerator, desc] of macShortcuts) {
            try {
                globalShortcut.register(accelerator, () => {
                    console.log(`${desc} blocked`);
                });
            } catch (error) {
                console.warn(`Could not block ${desc}:`, error.message);
            }
        }
    }

    // Block Alt+F4 on Windows
    if (process.platform === 'win32') {
        try {
            globalShortcut.register('Alt+F4', () => {
                console.log('Alt+F4 blocked');
            });
        } catch (error) {
            console.error('Error blocking Alt+F4:', error);
        }
    }

    // Register global shortcut for exit — only allowed method to quit
    try {
        globalShortcut.register('CommandOrControl+Shift+Q', () => {
            // Block exit during examination
            if (isExamMode) {
                console.log('Exit blocked: exam mode active');
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('show-sweetalert-dialog', {
                        title: 'Exit Disabled During Exam',
                        text: 'You cannot exit the application while an examination is in progress.',
                        icon: 'warning',
                        confirmButtonText: 'OK',
                        allowOutsideClick: false,
                        allowEscapeKey: false
                    });
                }
                return;
            }

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

                const handler = (event, confirmed) => {
                    ipcMain.removeListener('sweetalert-confirm-response', handler);
                    if (confirmed) {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('send-exit-audit-log');
                            setTimeout(() => {
                                app.exit(0);
                            }, 500);
                        } else {
                            app.exit(0);
                        }
                    }
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
