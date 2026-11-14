"use strict";
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.state = void 0;
exports.createWindow = createWindow;
exports.createVoiceWindow = createVoiceWindow;
exports.stopVoiceWindow = stopVoiceWindow;
exports.hideMainWindow = hideMainWindow;
exports.showMainWindow = showMainWindow;
exports.toggleMainWindow = toggleMainWindow;
exports.setWindowDimensions = setWindowDimensions;
exports.moveWindowHorizontal = moveWindowHorizontal;
exports.moveWindowVertical = moveWindowVertical;
exports.getMainWindow = getMainWindow;
exports.getView = getView;
exports.setView = setView;
exports.getScreenshotHelper = getScreenshotHelper;
exports.getProblemInfo = getProblemInfo;
exports.setProblemInfo = setProblemInfo;
exports.getScreenshotQueue = getScreenshotQueue;
exports.getExtraScreenshotQueue = getExtraScreenshotQueue;
exports.clearQueues = clearQueues;
exports.takeScreenshot = takeScreenshot;
exports.getImagePreview = getImagePreview;
exports.deleteScreenshot = deleteScreenshot;
exports.setHasDebugged = setHasDebugged;
exports.getHasDebugged = getHasDebugged;
exports.getMobileBridgeInfo = getMobileBridgeInfo;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const ipcHandlers_1 = require("./ipcHandlers");
const ProcessingHelper_1 = require("./ProcessingHelper");
const ScreenshotHelper_1 = require("./ScreenshotHelper");
const shortcuts_1 = require("./shortcuts");
const autoUpdater_1 = require("./autoUpdater");
const ConfigHelper_1 = require("./ConfigHelper");
const dotenv = __importStar(require("dotenv"));
const RegionSelector_1 = require("./RegionSelector");
const MouseGestureHelper_1 = require("./MouseGestureHelper");
const AccessGuard_1 = require("./AccessGuard");
const ConfigBackupHelper_1 = require("./ConfigBackupHelper");
const HistoryHelper_1 = require("./HistoryHelper");
const MobileBridge_1 = require("./MobileBridge");
const ContextManager_1 = require("./ContextManager");
// 🔊 启用 Chromium 内置的系统音频回环（用于 Auto 模式只录面试官声音）
// Windows 上此参数无害；macOS 13+ 上它会激活 ScreenCaptureKit 的纯音频采集通道
electron_1.app.commandLine.appendSwitch(
  "enable-features",
  "MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride",
);
// Constants
const isDev = process.env.NODE_ENV === "development";
// Application State
const state = {
  // Window management properties
  mainWindow: null,
  voiceWindow: null, // 🆕 语音窗口
  isWindowVisible: false,
  windowPosition: null,
  windowSize: null,
  screenWidth: 0,
  screenHeight: 0,
  step: 0,
  currentX: 0,
  currentY: 0,
  lockWindowWidth: false,
  savedOpacity: 1.0,
  suspendResize: false,
  // Application helpers
  screenshotHelper: null,
  shortcutsHelper: null,
  processingHelper: null,
  regionSelector: null,
  mouseGestureHelper: null,
  historyHelper: null,
  mobileBridge: null,
  // View and state management
  view: "queue",
  problemInfo: null,
  hasDebugged: false,
  // Processing events
  PROCESSING_EVENTS: {
    UNAUTHORIZED: "processing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",
    OUT_OF_CREDITS: "out-of-credits",
    API_KEY_INVALID: "api-key-invalid",
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_PROGRESS: "solution-progress", // 🚀 新增：流式响应进度事件
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error",
  },
};
exports.state = state;
// Initialize helpers
function initializeHelpers() {
  state.historyHelper = new HistoryHelper_1.HistoryHelper();
  state.screenshotHelper = new ScreenshotHelper_1.ScreenshotHelper(
    state.view,
    (path) => {
      const win = state.mainWindow;
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send("screenshot-capture-log", { path });
        } catch (err) {
          console.warn("Failed to send screenshot capture log", err);
        }
      }
    },
  );
  state.processingHelper = new ProcessingHelper_1.ProcessingHelper({
    getScreenshotHelper,
    getMainWindow,
    getView,
    setView,
    getProblemInfo,
    setProblemInfo,
    getScreenshotQueue,
    getExtraScreenshotQueue,
    clearQueues,
    takeScreenshot,
    getImagePreview,
    deleteScreenshot,
    setHasDebugged,
    getHasDebugged,
    PROCESSING_EVENTS: state.PROCESSING_EVENTS,
  });
  state.shortcutsHelper = new shortcuts_1.ShortcutsHelper({
    getMainWindow,
    takeScreenshot,
    takeScreenshotWithRegion,
    getImagePreview,
    processingHelper: state.processingHelper,
    clearQueues,
    setView,
    isVisible: () => state.isWindowVisible,
    toggleMainWindow,
    moveWindowLeft: () =>
      moveWindowHorizontal((x) =>
        Math.max(-(state.windowSize?.width || 0) / 2, x - state.step),
      ),
    moveWindowRight: () =>
      moveWindowHorizontal((x) =>
        Math.min(
          state.screenWidth - (state.windowSize?.width || 0) / 2,
          x + state.step,
        ),
      ),
    moveWindowUp: () => moveWindowVertical((y) => y - state.step),
    moveWindowDown: () => moveWindowVertical((y) => y + state.step),
    normalizeWindowPosition,
    resizeSolutionsForZoom,
    triggerReset,
  });
  state.mouseGestureHelper = new MouseGestureHelper_1.MouseGestureHelper({
    triggerScreenshot: triggerScreenshotAndNotify,
  });
  state.regionSelector = new RegionSelector_1.RegionSelector({
    ensureHookStarted: () => state.mouseGestureHelper?.start() ?? false,
  });
  state.mouseGestureHelper.start();
}
// Auth callback handler
// Register the interview-coder protocol
if (process.platform === "darwin") {
  electron_1.app.setAsDefaultProtocolClient("interview-coder");
} else {
  electron_1.app.setAsDefaultProtocolClient(
    "interview-coder",
    process.execPath,
    [path_1.default.resolve(process.argv[1] || "")],
  );
}
// Handle the protocol. In this case, we choose to show an Error Box.
if (process.defaultApp && process.argv.length >= 2) {
  electron_1.app.setAsDefaultProtocolClient(
    "interview-coder",
    process.execPath,
    [path_1.default.resolve(process.argv[1])],
  );
}
// Force Single Instance Lock
const gotTheLock = electron_1.app.requestSingleInstanceLock();
if (!gotTheLock) {
  electron_1.app.quit();
} else {
  electron_1.app.on("second-instance", (event, commandLine) => {
    // Someone tried to run a second instance, we should focus our window.
    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) state.mainWindow.restore();
      state.mainWindow.focus();
      // Handle Deep Link auth callback (Overseas Google OAuth)
      const url = commandLine.find((arg) =>
        arg.startsWith("interview-coder://"),
      );
      if (url) {
        handleAuthCallback(url);
      }
    }
  });
}
// Handle Deep Link on macOS (Overseas Google OAuth)
electron_1.app.on("open-url", (event, url) => {
  event.preventDefault();
  handleAuthCallback(url);
});
// Auth callback handler for Deep Link (Overseas Google OAuth)
// This function is only triggered by interview-coder://auth?token=xxx URLs,
// which are produced by the overseas Google OAuth flow. The domestic (license key)
// version never generates these URLs, so this code path is never reached in domestic builds.
function handleAuthCallback(url) {
  try {
    const urlObj = new URL(url);
    // Handle auth callback: interview-coder://auth?token=xxx
    if (urlObj.hostname === "auth" || urlObj.pathname === "/auth") {
      const token = urlObj.searchParams.get("token");
      const error = urlObj.searchParams.get("error");
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send("auth-callback", { token, error });
        // Focus the window
        if (state.mainWindow.isMinimized()) state.mainWindow.restore();
        state.mainWindow.focus();
      }
    }
  } catch (e) {
    console.error("Failed to handle auth callback:", e);
  }
}
// Window management functions
async function createWindow() {
  if (state.mainWindow) {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore();
    state.mainWindow.focus();
    return;
  }
  const primaryDisplay = electron_1.screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workAreaSize;
  state.screenWidth = workArea.width;
  state.screenHeight = workArea.height;
  state.step = 60;
  state.currentY = 50;
  const windowSettings = {
    width: 800,
    height: 600,
    minWidth: 300,
    minHeight: 260,
    x: state.currentX,
    y: 50,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: isDev
        ? path_1.default.join(__dirname, "../dist-electron/preload.js")
        : path_1.default.join(__dirname, "preload.js"),
      scrollBounce: true,
    },
    show: true,
    frame: false,
    transparent: true,
    fullscreenable: false,
    hasShadow: false,
    opacity: 1.0, // Start with full opacity
    backgroundColor: "#00000000",
    focusable: false,
    skipTaskbar: true,
    type: "panel",
    paintWhenInitiallyHidden: true,
    titleBarStyle: "hidden",
    enableLargerThanScreen: true,
    movable: true,
  };
  state.mainWindow = new electron_1.BrowserWindow(windowSettings);
  try {
    state.mobileBridge?.attachWebContents(state.mainWindow.webContents);
  } catch (error) {
    console.warn("[mobile] failed to attach companion bridge:", error);
  }
  // Add more detailed logging for window events
  state.mainWindow.webContents.on("did-finish-load", () => {
    console.log("Window finished loading");
  });
  state.mainWindow.webContents.on(
    "did-fail-load",
    async (event, errorCode, errorDescription) => {
      console.error("Window failed to load:", errorCode, errorDescription);
      if (isDev) {
        // In development, retry loading after a short delay
        console.log("Retrying to load development server...");
        setTimeout(() => {
          state.mainWindow?.loadURL("http://localhost:54321").catch((error) => {
            console.error("Failed to load dev server on retry:", error);
          });
        }, 1000);
      }
    },
  );
  if (isDev) {
    // In development, load from the dev server
    console.log("Loading from development server: http://localhost:54321");
    state.mainWindow.loadURL("http://localhost:54321").catch((error) => {
      console.error(
        "Failed to load dev server, falling back to local file:",
        error,
      );
      // Fallback to local file if dev server is not available
      const indexPath = path_1.default.join(__dirname, "../dist/index.html");
      console.log("Falling back to:", indexPath);
      if (fs_1.default.existsSync(indexPath)) {
        state.mainWindow.loadFile(indexPath);
      } else {
        console.error("Could not find index.html in dist folder");
      }
    });
  } else {
    // In production, load from the built files
    const indexPath = path_1.default.join(__dirname, "../dist/index.html");
    console.log("Loading production build:", indexPath);
    if (fs_1.default.existsSync(indexPath)) {
      state.mainWindow.loadFile(indexPath);
    } else {
      console.error("Could not find index.html in dist folder");
    }
  }
  // Configure window behavior
  state.mainWindow.webContents.setZoomFactor(1);
  if (isDev && process.env.ELECTRON_OPEN_DEVTOOLS === "1") {
    state.mainWindow.webContents.openDevTools();
  }
  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log("Attempting to open URL:", url);
    try {
      const parsedURL = new URL(url);
      const hostname = parsedURL.hostname;
      const allowedHosts = ["google.com", "supabase.co"];
      if (
        allowedHosts.includes(hostname) ||
        hostname.endsWith(".google.com") ||
        hostname.endsWith(".supabase.co")
      ) {
        electron_1.shell.openExternal(url);
        return { action: "deny" }; // Do not open this URL in a new Electron window
      }
    } catch (error) {
      console.error("Invalid URL %d in setWindowOpenHandler: %d", url, error);
      return { action: "deny" }; // Deny access as URL string is malformed or invalid
    }
    return { action: "allow" };
  });
  // Enhanced screen capture resistance
  state.mainWindow.setContentProtection(true);
  state.mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  state.mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
  // Additional screen capture resistance settings
  if (process.platform === "darwin") {
    // Prevent window from being captured in screenshots
    state.mainWindow.setHiddenInMissionControl(true);
    state.mainWindow.setWindowButtonVisibility(false);
    state.mainWindow.setBackgroundColor("#00000000");
    // Prevent window from being included in window switcher
    state.mainWindow.setSkipTaskbar(true);
    // Disable window shadow
    state.mainWindow.setHasShadow(false);
  }
  // Prevent the window from being captured by screen recording
  state.mainWindow.webContents.setBackgroundThrottling(false);
  state.mainWindow.webContents.setFrameRate(60);
  // Set up window listeners
  state.mainWindow.on("move", handleWindowMove);
  state.mainWindow.on("resize", handleWindowResize);
  state.mainWindow.on("closed", handleWindowClosed);
  // Initialize window state
  const bounds = state.mainWindow.getBounds();
  state.windowPosition = { x: bounds.x, y: bounds.y };
  state.windowSize = { width: bounds.width, height: bounds.height };
  state.currentX = bounds.x;
  state.currentY = bounds.y;
  state.isWindowVisible = true;
  // Set opacity based on user preferences or hide initially
  // Ensure the window is visible for the first launch or if opacity > 0.1
  const savedOpacity = ConfigHelper_1.configHelper.getOpacity();
  console.log(`Initial opacity from config: ${savedOpacity}`);
  state.savedOpacity = savedOpacity;
  // Always make sure window is shown first
  state.mainWindow.showInactive(); // Use showInactive for consistency
  if (savedOpacity <= 0.1) {
    console.log("Initial opacity too low, setting to 0 and hiding window");
    state.mainWindow.setOpacity(0);
    state.isWindowVisible = false;
  } else {
    console.log(`Setting initial opacity to ${savedOpacity}`);
    state.mainWindow.setOpacity(savedOpacity);
    state.isWindowVisible = true;
  }
  // 🔊 [Auto Mode] 注册系统音频回环拦截器
  // 当渲染进程调用 navigator.mediaDevices.getDisplayMedia() 时，
  // 不会弹出"选择屏幕"的弹窗，而是静默返回系统音频流（面试官的声音）
  // Mac 13+: 走 ScreenCaptureKit (配合上方 MacLoopbackAudioForScreenShare 标志)
  // Windows 10+: 走 WASAPI 系统环回
  state.mainWindow.webContents.session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      console.log(
        "[loopback-handler] getDisplayMedia called by renderer, intercepting...",
      );
      try {
        // Chromium 要求如果有 video:true，就必须给一个合法的 video source。
        // 我们随便拿一个桌面源给它（反正渲染进程拿到后会立刻 stop 丢弃它）
        const { desktopCapturer } = require("electron");
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        const screen = sources[0]; // 随便挑一个屏幕
        if (!screen) {
          console.error(
            "[loopback-handler] no screen found for dummy video source",
          );
          // @ts-ignore
          return callback({ audio: "loopback" });
        }
        console.log(
          "[loopback-handler] returning loopback audio + dummy video source",
        );
        // 返回：真实的系统音频 (loopback) + 虚拟的占位视频
        callback({
          video: screen,
          audio: "loopback",
        });
      } catch (e) {
        console.error("[loopback-handler] error getting sources:", e);
        // @ts-ignore
        callback({ audio: "loopback" });
      }
    },
  );
  console.log(
    "[loopback-handler] Display media request handler registered successfully",
  );
}
function handleWindowMove() {
  if (!state.mainWindow) return;
  const bounds = state.mainWindow.getBounds();
  // 始终更新 windowPosition（供显示/隐藏等功能使用）
  state.windowPosition = { x: bounds.x, y: bounds.y };
  // 核心修复：防止 DPI 舍入误差累积漂移
  // 当我们用代码调用 setPosition() 时，系统也会触发 on('move') 事件回调，
  // 但系统返回的坐标因为 DPI 物理像素取整，可能比我们设置的值少 1~2 像素。
  // 如果无条件覆盖 state.currentX，每次按键移动都会引入一个误差，
  // 长时间连续按键就会导致窗口向左累积漂移。
  // 解决办法：只有当系统报告的坐标和我们记录的差值超过 2px 时（说明是用户真实拖拽或系统强制移动），
  // 才采信系统的坐标；否则继续相信我们自己计算的精准值。
  const DPI_TOLERANCE = 2;
  if (Math.abs(bounds.x - state.currentX) > DPI_TOLERANCE) {
    state.currentX = bounds.x;
  }
  if (Math.abs(bounds.y - state.currentY) > DPI_TOLERANCE) {
    state.currentY = bounds.y;
  }
  // try { console.log(`[WM][MOVE] ${JSON.stringify(bounds)}`) } catch {}
}
function handleWindowResize() {
  if (!state.mainWindow) return;
  const bounds = state.mainWindow.getBounds();
  state.windowSize = { width: bounds.width, height: bounds.height };
  // try { console.log(`[WM][RESIZE] ${JSON.stringify(bounds)}`) } catch {}
}
function handleWindowClosed() {
  solutionsWidthBeforeZoom = null;
  state.mainWindow = null;
  state.isWindowVisible = false;
  state.windowPosition = null;
  state.windowSize = null;
}
// Window visibility functions
function hideMainWindow() {
  if (!state.mainWindow?.isDestroyed()) {
    const bounds = state.mainWindow.getBounds();
    // try { console.log(`[WM][HIDE] before=${JSON.stringify(bounds)} op=${state.mainWindow.getOpacity()}`) } catch {}
    state.windowPosition = { x: bounds.x, y: bounds.y };
    state.windowSize = { width: bounds.width, height: bounds.height };
    // Remember current opacity so we can restore it later
    try {
      state.savedOpacity = state.mainWindow.getOpacity();
    } catch {}
    state.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    state.mainWindow.setOpacity(0);
    state.isWindowVisible = false;
    // console.log('Window hidden, opacity set to 0');
  }
}
function createScreenshotWindowStateHandlers() {
  const wasVisible = state.isWindowVisible;
  const previousSavedOpacity = state.savedOpacity;
  let previousOpacity = previousSavedOpacity;
  try {
    previousOpacity = state.mainWindow?.getOpacity() ?? previousSavedOpacity;
  } catch {}
  const keepHidden = () => {
    if (!state.mainWindow?.isDestroyed()) {
      try {
        state.mainWindow.setIgnoreMouseEvents(true, { forward: true });
      } catch {}
      try {
        state.mainWindow.setOpacity(0);
      } catch {}
    }
    state.savedOpacity = previousSavedOpacity;
    state.isWindowVisible = false;
  };
  return {
    hideForScreenshot: () => {
      if (wasVisible) {
        hideMainWindow();
      } else {
        keepHidden();
      }
    },
    restoreAfterScreenshot: () => {
      if (wasVisible) {
        state.savedOpacity = previousOpacity;
        showMainWindow();
        // Showing the window resets native mouse-ignore state. Resync Queue only.
        const win = state.mainWindow;
        if (state.view === "queue" && win && !win.isDestroyed()) {
          const cursor = electron_1.screen.getCursorScreenPoint();
          const bounds = win.getContentBounds();
          const zoom = win.webContents.getZoomFactor();
          win.webContents.send("queue-screenshot-restored", {
            x: (cursor.x - bounds.x) / zoom,
            y: (cursor.y - bounds.y) / zoom,
          });
        }
      } else {
        keepHidden();
      }
    },
  };
}
// Region selection overlay window and helpers (deprecated)
let selectionWindow = null;
async function startRegionSelection() {
  // Deprecated overlay-based selection. Kept as stub to avoid dead references.
  return null;
}
// Windows worker rollback: remove these wrappers and rename the *Now functions back.
// Serialize BEFORE saving visibility/opacity, so queued requests cannot remember
// another capture's temporary hidden state. macOS retains its original flow.
let windowsScreenshotTasks = Promise.resolve();
function serializeWindowsScreenshot(task) {
  if (process.platform !== "win32") return task();
  const result = windowsScreenshotTasks.then(task);
  windowsScreenshotTasks = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
let isRegionScreenshotInProgress = false;
function takeScreenshotWithRegion() {
  if (isRegionScreenshotInProgress) return Promise.resolve(null);
  return serializeWindowsScreenshot(takeScreenshotWithRegionNow);
}
async function takeScreenshotWithRegionNow() {
  if (isRegionScreenshotInProgress) return null;
  isRegionScreenshotInProgress = true;
  try {
    const g = (0, AccessGuard_1.guardFeatureAccess)();
    if (!g.ok) throw new Error(`license_invalid:${g.reason || "unknown"}`);
    if (!state.regionSelector) {
      state.regionSelector = new RegionSelector_1.RegionSelector({
        ensureHookStarted: () => state.mouseGestureHelper?.start() ?? false,
      });
    }
    state.mouseGestureHelper?.pause();
    const rect = await state.regionSelector.selectRegion(10000);
    if (!rect) return null;
    const { hideForScreenshot, restoreAfterScreenshot } =
      createScreenshotWindowStateHandlers();
    const screenshotPath = await state.screenshotHelper?.takeScreenshot(
      hideForScreenshot,
      restoreAfterScreenshot,
      rect,
    );
    if (screenshotPath) {
      const historyStarted = performance.now();
      await state.historyHelper?.recordScreenshot(screenshotPath);
      console.log(
        `[ScreenshotTiming][${path_1.default.basename(screenshotPath, path_1.default.extname(screenshotPath))}] history=${(performance.now() - historyStarted).toFixed(1)}ms`,
      );
    }
    return screenshotPath || null;
  } catch (e) {
    console.error("takeScreenshotWithRegion failed", e);
    return null;
  } finally {
    state.mouseGestureHelper?.resume();
    isRegionScreenshotInProgress = false;
  }
}
function showMainWindow() {
  if (!state.mainWindow?.isDestroyed()) {
    // try { console.log(`[WM][SHOW] restoring pos/size=${JSON.stringify({ ...state.windowPosition, ...state.windowSize })}`) } catch {}
    if (state.windowPosition && state.windowSize) {
      // 先规范化，避免越界导致显示在屏外
      normalizeWindowPosition();
      state.mainWindow.setBounds({
        ...state.windowPosition,
        ...state.windowSize,
      });
    }
    // Enable mouse events; rely on CSS pointer-events to pass-through non-interactive areas
    try {
      state.mainWindow.setIgnoreMouseEvents(false);
    } catch {}
    state.mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    state.mainWindow.setContentProtection(true);
    // Restore previous opacity (or config fallback) before showing
    try {
      state.mainWindow.setOpacity(state.savedOpacity ?? 1);
    } catch {}
    // try { console.log(`[WM][SHOW] after=${JSON.stringify(state.mainWindow.getBounds())} op=${state.mainWindow.getOpacity()}`) } catch {}
    // 显示后同步状态位，避免日志误导
    state.isWindowVisible = true;
  }
}
function toggleMainWindow() {
  console.log(
    `Toggling window. Current state: ${state.isWindowVisible ? "visible" : "hidden"}`,
  );
  if (state.isWindowVisible) {
    hideMainWindow();
  } else {
    showMainWindow();
  }
}
// Window movement functions
function moveWindowHorizontal(updateFn) {
  if (!state.mainWindow) return;
  state.currentX = updateFn(state.currentX);
  state.mainWindow.setPosition(
    Math.round(state.currentX),
    Math.round(state.currentY),
  );
}
function moveWindowVertical(updateFn) {
  if (!state.mainWindow) return;
  // 先对 currentY 做一次夹取，防止越界后无法移动
  const winH = state.windowSize?.height || state.mainWindow.getBounds().height;
  const maxUpLimit0 = (-winH * 2) / 3;
  const maxDownLimit0 = state.screenHeight + (winH * 2) / 3;
  if (state.currentY < maxUpLimit0) state.currentY = maxUpLimit0;
  if (state.currentY > maxDownLimit0) state.currentY = maxDownLimit0;
  const newY = updateFn(state.currentY);
  // Allow window to go 2/3 off screen in either direction
  const maxUpLimit = (-(state.windowSize?.height || 0) * 2) / 3;
  const maxDownLimit =
    state.screenHeight + ((state.windowSize?.height || 0) * 2) / 3;
  // Log the current state and limits
  console.log({
    newY,
    maxUpLimit,
    maxDownLimit,
    screenHeight: state.screenHeight,
    windowHeight: state.windowSize?.height,
    currentY: state.currentY,
  });
  // Only update if within bounds
  if (newY >= maxUpLimit && newY <= maxDownLimit) {
    state.currentY = newY;
    state.mainWindow.setPosition(
      Math.round(state.currentX),
      Math.round(state.currentY),
    );
  }
}
// 🎤 Voice Recognition Window Functions
// ⚠️ DEPRECATED: 此函数用于旧的 FunASR 实现（连接到 mianshiguodong.top）
// 当前推荐使用 Paraformer/LiveTranslate 的前端录制方案（paraformerRealtimeClient.ts / liveTranslateRealtimeClient.ts）
function createVoiceWindow() {
  // 为了稳定性：始终重建语音窗口（避免 stop 后资源未完全释放时的复用问题）
  if (state.voiceWindow && !state.voiceWindow.isDestroyed()) {
    try {
      console.log("Voice window exists, destroying for a clean restart...");
      state.voiceWindow.destroy();
    } catch (e) {
      console.warn("Failed to destroy existing voice window:", e);
    }
    state.voiceWindow = null;
  }
  // 创建完全隐形的语音服务窗口
  const voiceSettings = {
    width: 400,
    height: 300,
    x: -2000, // 放到屏幕外不可见区域
    y: -2000,
    show: false, // 永不显示
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: isDev
        ? path_1.default.join(__dirname, "../dist-electron/preload.js")
        : path_1.default.join(__dirname, "preload.js"),
      allowRunningInsecureContent: true, // 允许麦克风访问
    },
    // 继承反检测特性
    frame: false,
    transparent: true,
    alwaysOnTop: false, // 不需要置顶
    skipTaskbar: true,
    hasShadow: false,
    opacity: 0,
    backgroundColor: "#00000000",
    focusable: false, // 不获取焦点
    type: "panel",
  };
  state.voiceWindow = new electron_1.BrowserWindow(voiceSettings);
  // 加载html5_client
  const voiceHtmlPath = path_1.default.join(
    __dirname,
    "../html5_client/index.html",
  );
  console.log("Loading voice recognition service:", voiceHtmlPath);
  if (fs_1.default.existsSync(voiceHtmlPath)) {
    state.voiceWindow.loadFile(voiceHtmlPath);
  } else {
    console.error("Could not find html5_client/index.html");
  }
  // 设置麦克风权限
  state.voiceWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === "media") {
        callback(true); // 允许麦克风访问
      } else {
        callback(false);
      }
    },
  );
  state.voiceWindow.on("closed", () => {
    state.voiceWindow = null;
  });
  // 永远不显示窗口
  state.voiceWindow.on("ready-to-show", () => {
    // 什么都不做，保持隐形
  });
  // 窗口加载完成后自动开始录音
  state.voiceWindow.webContents.once("did-finish-load", () => {
    console.log("Voice window loaded, starting recording...");
    setTimeout(() => {
      state.voiceWindow?.webContents
        .executeJavaScript(
          `
        if (typeof start === 'function' && typeof record === 'function') {
          // 按照FunASR流程：连接 → 开始录音
          start(); // 连接服务器
          setTimeout(() => {
            if (typeof record === 'function') {
              record(); // 开始录音
            }
          }, 1000); // 等待1秒连接建立
        }
      `,
        )
        .catch((err) => console.error("Error auto-starting recording:", err));
    }, 2000); // 等待2秒确保页面完全加载
  });
}
function showVoiceWindow() {
  if (!state.voiceWindow) {
    createVoiceWindow();
  }
  // 不调用show()，保持完全隐形
}
function hideVoiceWindow() {
  if (state.voiceWindow && !state.voiceWindow.isDestroyed()) {
    state.voiceWindow.hide(); // 即使调用hide也不会有视觉变化，因为本来就不可见
  }
}
// 🎤 停止语音录制
async function stopVoiceWindow() {
  if (!state.voiceWindow || state.voiceWindow.isDestroyed()) {
    console.log("Voice window not available for stopping");
    return false;
  }
  try {
    // 调用html5_client的stop()函数
    const result = await state.voiceWindow.webContents.executeJavaScript(`
      if (typeof stop === 'function') {
        stop();
        true;
      } else {
        console.error('stop function not found in voice window');
        false;
      }
    `);
    console.log("Voice recording stopped:", result);
    // 稍等一会儿让前端彻底关闭 ws/释放设备后销毁窗口
    setTimeout(() => {
      try {
        if (state.voiceWindow && !state.voiceWindow.isDestroyed()) {
          state.voiceWindow.destroy();
          state.voiceWindow = null;
          console.log("Voice window destroyed after stop.");
        }
      } catch (e) {
        console.warn("Failed to destroy voice window after stop:", e);
      }
    }, 3500);
    return result;
  } catch (error) {
    console.error("Error stopping voice recording:", error);
    return false;
  }
}
// Solutions zoom-width fix: keep the pre-zoom width for other views.
// Rollback: remove this helper/state, its setView/closed hooks and the three
// resizeSolutionsForZoom calls in shortcuts.ts. Existing height/movement is untouched.
let solutionsWidthBeforeZoom = null;
function resizeSolutionsForZoom() {
  const win = state.mainWindow;
  if (
    !win ||
    win.isDestroyed() ||
    state.view !== "solutions" ||
    state.suspendResize
  )
    return;
  const bounds = win.getBounds();
  if (solutionsWidthBeforeZoom === null)
    solutionsWidthBeforeZoom = bounds.width;
  const workArea = electron_1.screen.getDisplayMatching(bounds).workArea;
  const availableWidth = Math.floor(workArea.x + workArea.width - bounds.x);
  const [minWidth] = win.getMinimumSize();
  // Never reposition an already partly off-screen window to make room for zoom.
  if (availableWidth < minWidth) return;
  const targetWidth = Math.max(
    minWidth,
    Math.min(
      availableWidth,
      Math.ceil(solutionsWidthBeforeZoom * win.webContents.getZoomFactor()),
    ),
  );
  // Explicit shortcut updates + equality guard avoid resize-observer feedback.
  if (targetWidth !== bounds.width) {
    win.setBounds({ ...bounds, width: targetWidth }, false);
  }
}
// Window dimension functions
function setWindowDimensions(width, height) {
  if (!state.mainWindow?.isDestroyed()) {
    if (state.suspendResize) {
      // try { console.log('[WM][SET] skip due to suspendResize') } catch {}
      return;
    }
    const bounds = state.mainWindow.getBounds();
    const [currentX, currentY] = state.mainWindow.getPosition();
    const minH = 200;
    // Remove max height cap: allow window to grow with content and zoom
    let zoomFactor = 1;
    try {
      zoomFactor = state.mainWindow.webContents.getZoomFactor();
    } catch {}
    const scaledHeight = Math.ceil(height * (zoomFactor || 1));
    try {
      const display = electron_1.screen.getDisplayMatching({
        x: currentX,
        y: currentY,
        width: bounds.width,
        height: bounds.height,
      });
      const wa = display.workArea;
      const maxH = Math.max(200, wa.height - 24);
      const targetHeight = Math.min(Math.max(scaledHeight, minH), maxH);
      // 保持当前 Y 坐标，只在超出屏幕边界时才调整
      let newY = currentY;
      if (newY < wa.y) {
        newY = wa.y; // 窗口顶部超出屏幕上边界，拉回来
      }
      if (newY + targetHeight > wa.y + wa.height) {
        newY = wa.y + wa.height - targetHeight; // 窗口底部超出屏幕下边界，往上移
      }
      state.mainWindow.setBounds({
        x: currentX,
        y: newY,
        width: bounds.width,
        height: targetHeight,
      });
      return;
    } catch {}
    // 回退路径：保持当前位置，只在超出边界时调整
    const primary = electron_1.screen.getPrimaryDisplay().workArea;
    const maxH2 = Math.max(200, primary.height - 24);
    const targetHeight2 = Math.min(Math.max(scaledHeight, minH), maxH2);
    let fallbackY = currentY;
    if (fallbackY < primary.y) {
      fallbackY = primary.y;
    }
    if (fallbackY + targetHeight2 > primary.y + primary.height) {
      fallbackY = primary.y + primary.height - targetHeight2;
    }
    state.mainWindow.setBounds({
      x: currentX,
      y: fallbackY,
      width: bounds.width,
      height: targetHeight2,
    });
  }
}
// Environment setup
function loadEnvVariables() {
  const localEnvPath = path_1.default.join(process.cwd(), ".env");
  const bundledEnvPath = path_1.default.join(process.resourcesPath, ".env");
  // 本地直接运行 dist-electron/main.js 时，虽然 NODE_ENV=production，
  // 但应用并未被 electron-builder 打包，此时仍应优先读取项目根目录 .env。
  if (isDev || !electron_1.app.isPackaged) {
    console.log("Loading env variables from:", localEnvPath);
    dotenv.config({ path: localEnvPath });
  } else {
    console.log("Loading env variables from:", bundledEnvPath);
    dotenv.config({ path: bundledEnvPath });
  }
  console.log("Environment variables loaded for open-source version");
}
// Initialize application
async function initializeApp() {
  try {
    // Set custom cache directory to prevent permission issues
    const appDataPath = path_1.default.join(
      electron_1.app.getPath("appData"),
      "interview-coder-v1",
    );
    const sessionPath = path_1.default.join(appDataPath, "session");
    const tempPath = path_1.default.join(appDataPath, "temp");
    const cachePath = path_1.default.join(appDataPath, "cache");
    // Create directories if they don't exist
    for (const dir of [appDataPath, sessionPath, tempPath, cachePath]) {
      if (!fs_1.default.existsSync(dir)) {
        fs_1.default.mkdirSync(dir, { recursive: true });
      }
    }
    electron_1.app.setPath("userData", appDataPath);
    electron_1.app.setPath("sessionData", sessionPath);
    electron_1.app.setPath("temp", tempPath);
    electron_1.app.setPath("cache", cachePath);
    loadEnvVariables();
    ConfigBackupHelper_1.configBackupHelper.start();
    // Ensure a configuration file exists
    if (!ConfigHelper_1.configHelper.hasApiKey()) {
      console.log(
        "No API key found in configuration. User will need to set up.",
      );
    }
    initializeHelpers();
    state.mobileBridge = new MobileBridge_1.MobileBridge({
      onAction: handleMobileAction,
    });
    await state.mobileBridge.start();
    try {
      const cfg = ConfigHelper_1.configHelper.loadConfig();
      if (cfg?.xingceMode !== false) {
        ConfigHelper_1.configHelper.updateConfig({ xingceMode: false });
        console.log("[Init] Force xingceMode=false at startup");
      }
    } catch (e) {
      console.warn("Set xingceMode=false failed:", e);
    }
    (0, ipcHandlers_1.initializeIpcHandlers)({
      getMainWindow,
      setWindowDimensions,
      getScreenshotQueue,
      getExtraScreenshotQueue,
      deleteScreenshot,
      getImagePreview,
      processingHelper: state.processingHelper,
      PROCESSING_EVENTS: state.PROCESSING_EVENTS,
      takeScreenshot,
      takeScreenshotWithRegion,
      getView,
      toggleMainWindow,
      clearQueues,
      setView,
      setSuspendResize: (v) => {
        state.suspendResize = v;
      },
      moveWindowLeft: () =>
        moveWindowHorizontal((x) =>
          Math.max(-(state.windowSize?.width || 0) / 2, x - state.step),
        ),
      moveWindowRight: () =>
        moveWindowHorizontal((x) =>
          Math.min(
            state.screenWidth - (state.windowSize?.width || 0) / 2,
            x + state.step,
          ),
        ),
      moveWindowUp: () => moveWindowVertical((y) => y - state.step),
      moveWindowDown: () => moveWindowVertical((y) => y + state.step),
      setHasDebugged,
      getHasDebugged,
      createVoiceWindow, // 🎤 新增：语音窗口创建函数
      stopVoiceWindow, // 🎤 新增：停止语音窗口函数
      historyHelper: state.historyHelper,
      getMobileBridgeInfo,
      updateMobileTranscriptState,
      triggerReset,
    });
    await createWindow();
    state.shortcutsHelper?.registerGlobalShortcuts();
    // Initialize auto-updater regardless of environment
    (0, autoUpdater_1.initAutoUpdater)();
    console.log(
      "Auto-updater initialized in",
      isDev ? "development" : "production",
      "mode",
    );
  } catch (error) {
    console.error("Failed to initialize application:", error);
    electron_1.app.quit();
  }
}
// Auth callback handling removed - no longer needed
electron_1.app.on("open-url", (event, url) => {
  console.log("open-url event received:", url);
  event.preventDefault();
});
// Handle second instance (removed auth callback handling)
electron_1.app.on("second-instance", (event, commandLine) => {
  console.log("second-instance event received:", commandLine);
  // Focus or create the main window
  if (!state.mainWindow) {
    createWindow();
  } else {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore();
    state.mainWindow.focus();
  }
});
// Prevent multiple instances of the app
if (!electron_1.app.requestSingleInstanceLock()) {
  electron_1.app.quit();
} else {
  electron_1.app.on("before-quit", () => {
    // Release the native global mouse hook before Electron tears down.
    state.mouseGestureHelper?.stop();
    // Stop the reusable Windows screenshot process; never leave an orphan on exit.
    state.screenshotHelper?.dispose();
    void state.historyHelper?.closeCurrentSession("before-quit");
    void state.mobileBridge?.stop();
  });
  electron_1.app.on("window-all-closed", () => {
    void state.historyHelper?.closeCurrentSession("window-all-closed");
    if (process.platform !== "darwin") {
      electron_1.app.quit();
      state.mainWindow = null;
    }
  });
}
electron_1.app.on("activate", () => {
  if (electron_1.BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
// State getter/setter functions
function getMainWindow() {
  return state.mainWindow;
}
function getView() {
  return state.view;
}
function setView(view) {
  const previousView = state.view;
  state.view = view;
  state.screenshotHelper?.setView(view);
  // Solutions-only zoom width: restore the original width before another view.
  if (previousView === view) return;
  if (view === "solutions") {
    resizeSolutionsForZoom();
  } else if (solutionsWidthBeforeZoom !== null) {
    const win = state.mainWindow;
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      if (bounds.width !== solutionsWidthBeforeZoom) {
        win.setBounds({ ...bounds, width: solutionsWidthBeforeZoom }, false);
      }
    }
    solutionsWidthBeforeZoom = null;
  }
}
function getScreenshotHelper() {
  return state.screenshotHelper;
}
function getProblemInfo() {
  return state.problemInfo;
}
function setProblemInfo(problemInfo) {
  state.problemInfo = problemInfo;
}
function getScreenshotQueue() {
  return state.screenshotHelper?.getScreenshotQueue() || [];
}
function getExtraScreenshotQueue() {
  return state.screenshotHelper?.getExtraScreenshotQueue() || [];
}
function clearQueues() {
  state.screenshotHelper?.clearQueues();
  state.problemInfo = null;
  setView("queue");
}
function takeScreenshot() {
  return serializeWindowsScreenshot(takeScreenshotNow);
}
async function takeScreenshotNow() {
  if (!state.mainWindow) throw new Error("No main window available");
  const g = (0, AccessGuard_1.guardFeatureAccess)();
  if (!g.ok) throw new Error(`license_invalid:${g.reason || "unknown"}`);
  const { hideForScreenshot, restoreAfterScreenshot } =
    createScreenshotWindowStateHandlers();
  const screenshotPath = await (state.screenshotHelper?.takeScreenshot(
    hideForScreenshot,
    restoreAfterScreenshot,
  ) || "");
  if (screenshotPath) {
    const historyStarted = performance.now();
    await state.historyHelper?.recordScreenshot(screenshotPath);
    console.log(
      `[ScreenshotTiming][${path_1.default.basename(screenshotPath, path_1.default.extname(screenshotPath))}] history=${(performance.now() - historyStarted).toFixed(1)}ms`,
    );
  }
  return screenshotPath;
}
/**
 * Shared mouse screenshot entry point. ScreenshotHelper remains responsible for
 * hiding/restoring the window and writing the screenshot queue.
 */
async function triggerScreenshotAndNotify() {
  const mainWindow = state.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("No main window available");
  }
  const cfg = ConfigHelper_1.configHelper.loadConfig();
  const isRegionMode = cfg?.screenshotMode === "region";
  const screenshotPath = isRegionMode
    ? await takeScreenshotWithRegion()
    : await takeScreenshot();
  // Region selection can be cancelled by the user; this is not an application error.
  if (!screenshotPath) return;
  const preview = await getImagePreview(screenshotPath);
  mainWindow.webContents.send("screenshot-taken", {
    path: screenshotPath,
    preview,
  });
}
async function getImagePreview(filepath) {
  return state.screenshotHelper?.getImagePreview(filepath) || "";
}
async function deleteScreenshot(path) {
  return (
    state.screenshotHelper?.deleteScreenshot(path) || {
      success: false,
      error: "Screenshot helper not initialized",
    }
  );
}
function setHasDebugged(value) {
  state.hasDebugged = value;
}
function getHasDebugged() {
  return state.hasDebugged;
}
function getMobileBridgeInfo() {
  return (
    state.mobileBridge?.getInfo() || {
      enabled: false,
      port: null,
      token: "",
      urls: [],
      connectedClients: 0,
    }
  );
}
function updateMobileTranscriptState(payload) {
  try {
    state.mobileBridge?.updateTranscriptState(payload);
  } catch (error) {
    console.warn("[mobile] failed to update transcript state:", error);
  }
}
function triggerReset() {
  try {
    ContextManager_1.contextManager.clear();
    state.processingHelper?.cancelOngoingRequests();
    clearQueues();
    state.mobileBridge?.clearSpeechState();
    setHasDebugged(false);
    setView("queue");
    normalizeWindowPosition();
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.webContents
        .executeJavaScript(
          `
        window.__TEXT_INPUT__ = "";
        window.__VOICE_SENTENCES__ = [];
        window.__VOICE_BUFFER__ = [];
        window.__VOICE_POINTER_POS__ = 0;
        window.__VOICE_FOLLOW_LATEST__ = true;
        window.__LAST_NON_KEYWORD__ = "";
        window.__LAST_VOICE_TRIGGER_AT__ = 0;
        window.__LAST_SCREENSHOT_TRIGGER_AT__ = 0;
        window.__PROCESSED_SENTENCE_IDS__ = new Set();
      `,
        )
        .catch((error) =>
          console.warn("Failed to clear renderer input state:", error),
        );
      mainWindow.webContents.send("clear-text-input");
      mainWindow.webContents.send("reset-view");
      mainWindow.webContents.send("reset");
    }
    return { success: true };
  } catch (error) {
    console.error("Error triggering reset:", error);
    return { success: false, error: "Failed to reset" };
  }
}
async function handleMobileAction(action) {
  try {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false, error: "No main window" };
    }
    if (
      action.key === "H" ||
      action.key === "Enter" ||
      action.key === "S" ||
      action.key === "D"
    ) {
      const access = (0, AccessGuard_1.guardFeatureAccess)();
      if (!access.ok) {
        return {
          success: false,
          error:
            access.region === "overseas"
              ? "Subscription inactive or expired"
              : "License inactive or expired",
        };
      }
    }
    if (action.key === "H") {
      const cfg = ConfigHelper_1.configHelper.loadConfig();
      const mode = cfg?.screenshotMode === "region" ? "region" : "full";
      const screenshotPath =
        mode === "region"
          ? await takeScreenshotWithRegion()
          : await takeScreenshot();
      if (!screenshotPath) {
        return { success: false, error: "Screenshot cancelled" };
      }
      const preview = await getImagePreview(screenshotPath);
      mainWindow.webContents.send("screenshot-taken", {
        path: screenshotPath,
        preview,
      });
      return { success: true, message: "Picture captured" };
    }
    if (action.key === "Enter") {
      void state.processingHelper?.processScreenshots().catch((error) => {
        console.error("[mobile] Enter action failed:", error);
      });
      return { success: true, message: "Enter accepted" };
    }
    if (action.key === "S") {
      const text = String(action.text || "").trim();
      if (!text) return { success: false, error: "No transcript" };
      void state.processingHelper?.processTextOnly(text).catch((error) => {
        console.error("[mobile] S action failed:", error);
      });
      return {
        success: true,
        message: `S${action.count || ""} accepted`,
      };
    }
    if (action.key === "D") {
      void state.processingHelper?.processWithInput().catch((error) => {
        console.error("[mobile] D action failed:", error);
      });
      return { success: true, message: "D accepted" };
    }
    if (action.key === "L") {
      state.mobileBridge?.clearSpeechState();
      mainWindow.webContents.send("delete-last-screenshot");
      mainWindow.webContents.send("clear-text-input");
      return { success: true, message: "L accepted" };
    }
    if (action.key === "R") {
      return triggerReset();
    }
    return { success: false, error: "Unsupported key" };
  } catch (error) {
    console.error("[mobile] action failed:", error);
    return {
      success: false,
      error: String(error?.message || error || "Action failed"),
    };
  }
}
function normalizeWindowPosition() {
  if (!state.mainWindow) return;
  const bounds = state.mainWindow.getBounds();
  const display = electron_1.screen.getDisplayMatching(bounds);
  const workArea =
    display?.workArea || electron_1.screen.getPrimaryDisplay().workArea;
  const winW = state.windowSize?.width || bounds.width;
  const winH = state.windowSize?.height || bounds.height;
  // Y 轴边界：严格夹取到工作区内
  const top = workArea.y;
  const bottom = workArea.y + workArea.height - winH;
  const clampedY = Math.min(Math.max(state.currentY, top), bottom);
  // X 轴边界：与 moveWindowRight / moveWindowLeft 保持一致——
  // 允许窗口左右各最多半个身位超出屏幕边缘，避免每次 Ctrl+R 将窗口
  // 向左推移约 windowWidth/2 导致的累积漂移问题。
  // 注意：用 != null 而非 ||，以正确处理 currentX === 0 的情况。
  const left = workArea.x - winW / 2;
  const right = workArea.x + workArea.width - winW / 2;
  const rawX = state.currentX != null ? state.currentX : bounds.x;
  const clampedX = Math.min(Math.max(rawX, left), right);
  state.currentX = clampedX;
  state.currentY = clampedY;
  if (!state.windowPosition)
    state.windowPosition = { x: clampedX, y: clampedY };
  state.windowPosition.x = clampedX;
  state.windowPosition.y = clampedY;
  state.mainWindow.setPosition(Math.round(clampedX), Math.round(clampedY));
}
electron_1.app.whenReady().then(initializeApp);
