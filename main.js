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
const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
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

// Windows: force DirectShow instead of MediaFoundation for camera capture.
// MediaFoundation's Camera Frame Server on Windows 11 24H2 takes too long to
// release the device after checkPermissions() stops the stream, causing
// "Timeout starting video zone" when the iframe immediately re-opens the camera.
if (process.platform === 'win32') {
    app.commandLine.appendSwitch('disable-features', 'MediaFoundationVideoCapture')
}

let mainWindow

// Windows-only: handles for background OS-level security helpers
let winKeyBlockerProcess = null;
let windowMonitorProcess = null;

// Installs a WH_KEYBOARD_LL hook via a hidden PowerShell process.
// The hook intercepts VK_LWIN, VK_RWIN, and Ctrl+Esc at the OS level —
// before Windows can route them to the Start menu — so the Start menu never
// opens even though our Electron window doesn't hold a keyboard hook natively.
function startWindowsKeyBlocker() {
    if (process.platform !== 'win32') return;

    const psScript = `
Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class WinKeyBlocker {
    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN     = 0x0100;
    private const int WM_SYSKEYDOWN  = 0x0104;
    private const int VK_LWIN        = 0x5B;
    private const int VK_RWIN        = 0x5C;
    private const int VK_ESCAPE      = 0x1B;
    private const int VK_CONTROL     = 0x11;
    private const int VK_SNAPSHOT    = 0x2C; // Print Screen

    private static IntPtr _hook = IntPtr.Zero;
    private static LowLevelKeyboardProc _proc;

    public static void Start() {
        _proc = HookCallback;
        using (var p = Process.GetCurrentProcess())
        using (var m = p.MainModule)
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(m.ModuleName), 0);
        Application.Run();
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN)) {
            int vk = Marshal.ReadInt32(lParam);
            if (vk == VK_LWIN || vk == VK_RWIN)
                return (IntPtr)1;
            if (vk == VK_ESCAPE && (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0)
                return (IntPtr)1;
            if (vk == VK_SNAPSHOT)
                return (IntPtr)1; // Block Print Screen / Win+PrintScreen
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }
}
"@
[WinKeyBlocker]::Start()
`;

    try {
        const scriptPath = path.join(os.tmpdir(), 'proctorx-kb.ps1');
        fs.writeFileSync(scriptPath, psScript, 'utf8');
        winKeyBlockerProcess = spawn('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden', '-File', scriptPath
        ], {windowsHide: true});
        winKeyBlockerProcess.on('error', (e) => console.error('[WinKeyBlocker] error:', e));
        console.log('[WinKeyBlocker] started, PID:', winKeyBlockerProcess.pid);
    } catch (e) {
        console.error('[WinKeyBlocker] failed to start:', e);
    }
}

// Spawns a hidden PowerShell loop that minimizes any foreground window not
// owned by our process.  Acts as a backstop for any attack vector that gets
// past the keyboard blocker (e.g. Alt+Tab after an unexpected focus loss).
function startWindowMonitor(examPID) {
    if (process.platform !== 'win32') return;

    const psScript = `
param([int]$ExamPID)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);
}
"@

while ($true) {
    try {
        $fg = [Win32]::GetForegroundWindow()
        [int]$fgPID = 0
        [Win32]::GetWindowThreadProcessId($fg, [ref]$fgPID) | Out-Null
        if ($fgPID -ne 0 -and $fgPID -ne $ExamPID -and [Win32]::IsWindowVisible($fg)) {
            [Win32]::ShowWindow($fg, 6) | Out-Null
        }
    } catch {}
    Start-Sleep -Milliseconds 100
}
`;

    try {
        const scriptPath = path.join(os.tmpdir(), 'proctorx-wmon.ps1');
        fs.writeFileSync(scriptPath, psScript, 'utf8');
        windowMonitorProcess = spawn('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden', '-File', scriptPath,
            '-ExamPID', String(examPID)
        ], {windowsHide: true});
        windowMonitorProcess.on('error', (e) => console.error('[WindowMonitor] error:', e));
        console.log('[WindowMonitor] started, PID:', windowMonitorProcess.pid);
    } catch (e) {
        console.error('[WindowMonitor] failed to start:', e);
    }
}

function stopWindowsHelpers() {
    if (winKeyBlockerProcess) {
        try {
            winKeyBlockerProcess.kill();
        } catch {
        }
        winKeyBlockerProcess = null;
    }
    if (windowMonitorProcess) {
        try {
            windowMonitorProcess.kill();
        } catch {
        }
        windowMonitorProcess = null;
    }
}

let deeplinkData = null;
let multipleDisplayAlertShowing = false; // Track if multiple display alert is showing
let isExamMode = false; // Track if user is on an exam page (disables exit shortcut)
const examFrameIds = new Set(); // routing IDs of frames currently on an exam URL

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

    // Resolve asset path: in a packaged app icon files are unpacked from asar so
    // native Win32 APIs (LoadImage) can read them as real files.
    function assetPath(relativePath) {
        if (app.isPackaged) {
            return path.join(process.resourcesPath, 'app.asar.unpacked', relativePath);
        }
        return path.join(__dirname, relativePath);
    }

    const platform = process.platform;
    let iconPath;
    if (platform === 'win32') {
        iconPath = assetPath('assets/icon.ico');
    } else if (platform === 'darwin') {
        iconPath = assetPath('assets/icon.icns');
    } else {
        iconPath = assetPath('assets/icon.png');
    }

    if (process.platform === 'darwin') {
        const icon = nativeImage.createFromPath(assetPath('assets/icon.png'));
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
        // width: 1000, // Default width (will be overridden by fullscreen)
        // height: 800, // Default height (will be overridden by fullscreen)
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

    // Windows: keep in taskbar and set our custom icon.
    // setIcon() is called here AND again in ready-to-show to handle timing edge-cases.
    if (process.platform === 'win32') {
        mainWindow.setSkipTaskbar(false);
        const winIcon = nativeImage.createFromPath(assetPath('assets/icon.ico'));
        if (!winIcon.isEmpty()) {
            mainWindow.setIcon(winIcon);
        } else {
            console.warn('Windows icon could not be loaded from:', assetPath('assets/icon.ico'));
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
            if (process.platform === 'win32') {
                mainWindow.setSkipTaskbar(false);
                mainWindow.setAlwaysOnTop(true, 'screen-saver');
                // Re-apply icon just before show() — most reliable point for taskbar icon
                const winIcon2 = nativeImage.createFromPath(assetPath('assets/icon.ico'));
                if (!winIcon2.isEmpty()) {
                    mainWindow.setIcon(winIcon2);
                }
            }

            mainWindow.show();
            mainWindow.focus();

            if (process.platform === 'win32') {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.setSkipTaskbar(false);
                    mainWindow.setAlwaysOnTop(true, 'screen-saver');
                    mainWindow.focus();
                }

                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(false);
                        mainWindow.setAlwaysOnTop(true, 'screen-saver');
                        mainWindow.focus();
                    }
                }, 50);

                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(false);
                        mainWindow.setAlwaysOnTop(true, 'screen-saver');
                        mainWindow.focus();
                    }
                }, 200);

                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(false);
                        mainWindow.setAlwaysOnTop(true, 'screen-saver');
                        mainWindow.focus();
                    }
                }, 500);

                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.setSkipTaskbar(false);
                        mainWindow.setAlwaysOnTop(true, 'screen-saver');
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

    // Force fullscreen back if student somehow exits it (e.g. via F11 edge case)
    mainWindow.on('leave-full-screen', () => {
        mainWindow.setFullScreen(true);
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

                // Immediately re-assert always-on-top and steal focus back
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.setAlwaysOnTop(true, 'screen-saver');
                    mainWindow.focus();
                }

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
                    mainWindow.setAlwaysOnTop(true, 'screen-saver');
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
                                mainWindow.setAlwaysOnTop(true, 'screen-saver');
                                mainWindow.focus();
                            }
                            if (!mainWindow.isAlwaysOnTop()) {
                                mainWindow.setAlwaysOnTop(true, 'screen-saver');
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

                            // If window loses focus, always re-assert on-top and focus.
                            // Only suppress additional dialogs while one is already showing.
                            if (!mainWindow.isFocused()) {
                                if (process.platform === 'win32') {
                                    mainWindow.setAlwaysOnTop(true, 'screen-saver');
                                }
                                mainWindow.focus();

                                if (!mainWindow._dialogShowing) {
                                    const now = Date.now();
                                    if ((now - (mainWindow._lastDialogTime || 0)) > 2000) {
                                        mainWindow._dialogShowing = true;
                                        mainWindow._lastDialogTime = now;

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

                                        setTimeout(() => {
                                            mainWindow._dialogShowing = false;
                                        }, 5000);
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

                                // Ensure always on top is maintained
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

        // Start OS-level helpers: keyboard blocker + window monitor
        mainWindow.once('ready-to-show', () => {
            startWindowsKeyBlocker();
            startWindowMonitor(process.pid);
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

        // Block F11 (fullscreen toggle) on all platforms
        if (input.key === 'F11') {
            event.preventDefault();
            return;
        }

        // Block Print Screen (screen capture) — key name varies by platform/driver
        if (input.key === 'PrintScreen' || input.key === 'Snapshot' || input.key === 'Print') {
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

        // Block F11 (fullscreen toggle) on all platforms
        if (input.key === 'F11') {
            event.preventDefault();
        }

        // Block Print Screen on all platforms
        if (input.key === 'PrintScreen' || input.key === 'Snapshot' || input.key === 'Print') {
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
    globalShortcut.unregisterAll();
    stopWindowsHelpers();
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

        // Block Print Screen variants (screen capture to clipboard / Snipping Tool)
        ['PrintScreen', 'Shift+PrintScreen', 'Control+PrintScreen', 'Alt+PrintScreen'].forEach(sc => {
            registerShortcut(sc, sc);
        });

        // Additional aggressive blocking will be set up after window is created
        // (moved to createWindow function to avoid accessing mainWindow before it exists)
    }

    // Block Cmd+Q on macOS so it cannot be used to quit
    if (process.platform === 'darwin') {
        try {
            globalShortcut.register('Command+Q', () => {
                console.log('Cmd+Q blocked');
            });
        } catch (error) {
            console.error('Error blocking Cmd+Q:', error);
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
